function app() {
    return {
        // UI
        showLogin: false,
        modal: '',
        activeTab: 'customers',
        login: { email: '', password: '' },

        // user
        user: { loggedIn: false, id: null, name: '', email: '', role: '' },

        // db
        SQL: null,
        db: null,

        // datasets mirrored to Alpine
        customers: [],
        templates: [],
        myServices: [],
        payments: [],

        // upcoming
        upcoming: [],

        // forms
        formCustomer: { name: '', email: '', password: '' },
        formTemplate: { name: '', description: '', monthly_price: '', yearly_price: '' },
        formService: { customer_id: null, customer_name: '', template_id: '', renewal_date: '', domain: '', showDomain: false, domainLabel: '' },

        // payment flow
        payingFor: null,
        payingType: '',

        async init() {
            // init sql.js
            this.SQL = await initSqlJs({
                locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}`
            });

            // load or create DB
            const persisted = localStorage.getItem('svc_db');
            if (persisted) {
                const arr = new Uint8Array(JSON.parse(persisted));
                this.db = new this.SQL.Database(arr);
            } else {
                this.db = new this.SQL.Database();
                this.createSchema();
                this.insertInitialData();
                this.save();
            }

            // Migration: add domain column if missing
            try {
                this.db.run("ALTER TABLE customer_services ADD COLUMN domain TEXT");
            } catch (e) { /* ignore if already exists */ }
            this.reloadAll();
        },

        // ---------- SQL helpers ----------
        run(sql, params = []) {
            // non-select
            const stmt = this.db.prepare(sql);
            try {
                stmt.bind(params);
                stmt.step();
            } finally {
                stmt.free();
            }
        },

        all(sql, params = []) {
            // return rows as arrays
            const stmt = this.db.prepare(sql);
            const rows = [];
            try {
                stmt.bind(params);
                while (stmt.step()) {
                    rows.push(stmt.get());
                }
            } finally {
                stmt.free();
            }
            return rows;
        },

        createSchema() {
            const queries = [
                `CREATE TABLE customers (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              email TEXT UNIQUE NOT NULL,
              password TEXT NOT NULL,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`,
                `CREATE TABLE service_templates (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              description TEXT,
              monthly_price REAL NOT NULL,
              yearly_price REAL NOT NULL
            )`,
                `CREATE TABLE customer_services (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              customer_id INTEGER,
              service_name TEXT NOT NULL,
              monthly_price REAL NOT NULL,
              yearly_price REAL NOT NULL,
              renewal_date DATE NOT NULL,
              payment_status TEXT DEFAULT 'active',
              domain TEXT,
              FOREIGN KEY (customer_id) REFERENCES customers(id)
            )`,
                `CREATE TABLE payments (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              customer_id INTEGER,
              service_id INTEGER,
              amount REAL NOT NULL,
              payment_type TEXT NOT NULL,
              status TEXT DEFAULT 'processing',
              payment_date DATETIME DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY(customer_id) REFERENCES customers(id),
              FOREIGN KEY(service_id) REFERENCES customer_services(id)
            )`
            ];
            queries.forEach(q => this.db.run(q));
        },

        insertInitialData() {
            // demo customer
            this.db.run(`INSERT INTO customers (name,email,password) VALUES ('John Doe','john@demo.com','password123')`);
            // demo templates
            this.db.run(`INSERT INTO service_templates (name,description,monthly_price,yearly_price) VALUES 
            ('Web Hosting','Premium web hosting',9.99,99.99),
            ('Domain Registration','Domain registration',12.99,129.99),
            ('Business Email','Email hosting',5.99,59.99)`);
            // demo service for John, renewal next month
            const future = new Date(); future.setMonth(future.getMonth() + 1);
            const iso = future.toISOString().split('T')[0];
            this.db.run(`INSERT INTO customer_services (customer_id,service_name,monthly_price,yearly_price,renewal_date) VALUES (1,'Web Hosting',9.99,99.99,?)`, [iso]);
        },

        save() {
            const exported = this.db.export();
            const arr = Array.from(exported);
            localStorage.setItem('svc_db', JSON.stringify(arr));
        },

        // reload data for UI
        reloadAll() {
            // customers
            const custRows = this.all("SELECT id,name,email,password,created_at FROM customers");
            this.customers = custRows.map(r => ({ id: r[0], name: r[1], email: r[2], password: r[3], created_at: r[4] }));
            // templates
            const tpl = this.all("SELECT id,name,description,monthly_price,yearly_price FROM service_templates");
            this.templates = tpl.map(r => ({ id: r[0], name: r[1], description: r[2], monthly_price: r[3], yearly_price: r[4] }));
            // payments latest first
            const pay = this.all("SELECT id,customer_id,service_id,amount,payment_type,status,payment_date FROM payments ORDER BY payment_date DESC");
            this.payments = pay.map(r => ({ id: r[0], customer_id: r[1], service_id: r[2], amount: r[3], payment_type: r[4], status: r[5], payment_date: r[6] }));
            // if logged in customer, load their services
            if (this.user.loggedIn && this.user.role === 'customer') {
                this.loadCustomerServices(this.user.id);
            } else {
                this.myServices = [];
            }
            this.computeUpcoming();
        },

        // ---------- Auth ----------
        performLogin() {
            // admin credentials
            if (this.login.email === 'admin@demo.com' && this.login.password === 'admin123') {
                this.user = { loggedIn: true, id: 0, name: 'Admin', email: 'admin@demo.com', role: 'admin' };
                this.showLogin = false;
                this.login = { email: '', password: '' };
                this.reloadAll();
                return;
            }
            // customer login (simple)
            const rows = this.all("SELECT id,name,email,password FROM customers WHERE email = ?", [this.login.email]);
            if (rows.length && rows[0][3] === this.login.password) {
                this.user = { loggedIn: true, id: rows[0][0], name: rows[0][1], email: rows[0][2], role: 'customer' };
                this.showLogin = false;
                this.login = { email: '', password: '' };
                this.loadCustomerServices(this.user.id);
                return;
            }
            alert('Invalid credentials');
        },

        logout() {
            this.user = { loggedIn: false, id: null, name: '', email: '', role: '' };
            this.activeTab = 'customers';
            this.myServices = [];
        },

        // ---------- Admin actions ----------
        openAddCustomer() {
            this.formCustomer = { name: '', email: '', password: '' };
            this.modal = 'addCustomer';
        },
        doAddCustomer() {
            try {
                this.run("INSERT INTO customers (name,email,password) VALUES (?,?,?)", [this.formCustomer.name, this.formCustomer.email, this.formCustomer.password]);
                this.save(); this.reloadAll(); this.modal = '';
                alert('Customer added');
            } catch (e) {
                alert('Error: ' + e.message);
            }
        },

        openAddTemplate() {
            this.formTemplate = { name: '', description: '', monthly_price: '', yearly_price: '' };
            this.modal = 'addTemplate';
        },
        doAddTemplate() {
            try {
                this.run("INSERT INTO service_templates (name,description,monthly_price,yearly_price) VALUES (?,?,?,?)", [this.formTemplate.name, this.formTemplate.description, parseFloat(this.formTemplate.monthly_price), parseFloat(this.formTemplate.yearly_price)]);
                this.save(); this.reloadAll(); this.modal = '';
                alert('Template added');
            } catch (e) { alert('Error: ' + e.message); }
        },
        editTemplate(t) {
            const np = prompt('New monthly price for ' + t.name, t.monthly_price);
            if (np !== null && !isNaN(np)) {
                this.run("UPDATE service_templates SET monthly_price=? WHERE id=?", [parseFloat(np), t.id]);
                this.save(); this.reloadAll();
                alert('Updated');
            }
        },
        deleteTemplate(t) {
            if (!confirm('Delete template ' + t.name + '?')) return;
            this.run("DELETE FROM service_templates WHERE id=?", [t.id]);
            this.save(); this.reloadAll();
        },

        openAddService(customer) {
            this.formService = { customer_id: customer.id, customer_name: customer.name, template_id: '', renewal_date: '', domain: '', showDomain: false, domainLabel: '' };
            this.modal = 'addService';
        },
        onTemplateChange() {
            const tpl = this.templates.find(t => t.id == this.formService.template_id);
            if (!tpl) {
                this.formService.showDomain = false;
                this.formService.domainLabel = '';
                return;
            }
            const name = tpl.name.toLowerCase();
            if (name.includes('domain')) {
                this.formService.showDomain = true;
                this.formService.domainLabel = 'Domain Name';
            } else if (name.includes('hosting')) {
                this.formService.showDomain = true;
                this.formService.domainLabel = 'Hosting Domain';
            } else if (name.includes('email')) {
                this.formService.showDomain = true;
                this.formService.domainLabel = 'Email Domain';
            } else {
                this.formService.showDomain = false;
                this.formService.domainLabel = '';
            }
        },
        doAddService() {
            if (!this.formService.template_id) return alert('Select a template');
            const tpl = this.all("SELECT id,name,monthly_price,yearly_price FROM service_templates WHERE id=?", [this.formService.template_id])[0];
            if (!tpl) return alert('Template not found');
            const tplName = tpl[1].toLowerCase();
            let domain = '';
            if ((tplName.includes('domain') || tplName.includes('hosting') || tplName.includes('email'))) {
                if (!this.formService.domain) return alert('Please enter the domain.');
                domain = this.formService.domain.trim();
            }
            this.run("INSERT INTO customer_services (customer_id,service_name,monthly_price,yearly_price,renewal_date,domain) VALUES (?,?,?,?,?,?)",
                [this.formService.customer_id, tpl[1], tpl[2], tpl[3], this.formService.renewal_date, domain]);
            this.save(); this.reloadAll(); this.modal = '';
            alert('Service added to ' + this.formService.customer_name);
        },

        viewCustomer(c) {
            const rows = this.all("SELECT id,service_name,renewal_date,payment_status,domain FROM customer_services WHERE customer_id=?", [c.id]);
            const lines = rows.map(r => `${r[1]} — ${r[2]} — ${r[3]}${r[4] ? ' — ' + r[4] : ''}`).join('\n') || 'No services';
            alert(`Customer: ${c.name}\nEmail: ${c.email}\n\nServices:\n${lines}`);
        },

        sendReminder(c) {
            // gather near-expiring services for this customer
            const rows = this.all("SELECT id,service_name,renewal_date FROM customer_services WHERE customer_id=?", [c.id]);
            const near = rows.filter(r => {
                const days = this.calcDays(r[2]); return days <= 30;
            });
            const body = near.length ? `Dear ${c.name},\n\nThe following services are near renewal:\n${near.map(n => n[1] + ' — ' + n[2]).join('\n')}\n\nPlease renew soon.` : `Dear ${c.name},\n\nYou have upcoming services.`;
            const mail = `mailto:${c.email}?subject=${encodeURIComponent('Service Renewal Reminder')}&body=${encodeURIComponent(body)}`;
            window.location.href = mail;
        },

        sendReminderById(customer_id, service) {
            const c = this.customers.find(x => x.id === customer_id);
            if (!c) return alert('Customer not found');
            const body = `Dear ${c.name},\n\nThis is a reminder that your service "${service.service_name}" renews on ${service.renewal_date}.\n\nRegards.`;
            window.location.href = `mailto:${c.email}?subject=${encodeURIComponent('Service Renewal Reminder')}&body=${encodeURIComponent(body)}`;
        },

        // ---------- Payments & Customer ----------
        startPay(service, type) {
            // show PayPal button for that service
            this.payingFor = service;
            this.payingType = type;
            // render PayPal buttons into container (we recreate each time)
            setTimeout(() => this.renderPayPal(service, type), 50);
        },

        renderPayPal(service, type) {
            // clear container
            const containerId = `paypal-button-container-${service.id}`;
            const container = document.getElementById(containerId);
            if (!container) return;
            container.innerHTML = '';
            const amount = (type === 'monthly') ? service.monthly_price : service.yearly_price;
            if (typeof paypal === 'undefined') {
                container.innerText = 'PayPal not loaded';
                return;
            }
            paypal.Buttons({
                createOrder: (data, actions) => {
                    return actions.order.create({
                        purchase_units: [{ amount: { value: String(amount) }, description: `${service.service_name} (${type})` }]
                    });
                },
                onApprove: async (data, actions) => {
                    const details = await actions.order.capture();
                    // record payment as processing and mark service processing
                    try {
                        // create payment
                        this.run("INSERT INTO payments (customer_id,service_id,amount,payment_type,status) VALUES (?,?,?,?,?)", [this.user.id, service.id, amount, type, 'processing']);
                        // update service payment_status
                        this.run("UPDATE customer_services SET payment_status='processing' WHERE id=?", [service.id]);
                        this.save(); this.reloadAll();
                        alert('Payment approved (demo). Admin will complete renewal.');
                        // hide paypal area
                        this.payingFor = null;
                        // cleanup buttons
                        container.innerHTML = '';
                    } catch (e) { alert('Error saving payment: ' + e.message); }
                },
                onCancel: function () { alert('Payment canceled'); },
                onError: function (err) { console.error(err); alert('PayPal error'); }
            }).render(`#${containerId}`);
        },

        loadCustomerServices(customerId) {
            const rows = this.all("SELECT id,customer_id,service_name,monthly_price,yearly_price,renewal_date,payment_status,domain FROM customer_services WHERE customer_id=?", [customerId]);
            this.myServices = rows.map(r => ({ id: r[0], customer_id: r[1], service_name: r[2], monthly_price: r[3], yearly_price: r[4], renewal_date: r[5], payment_status: r[6], domain: r[7] }));
        },

        // admin complete renewal
        completeRenewal(payment) {
            if (!confirm('Complete this renewal and extend date?')) return;
            // get service
            const svc = this.all("SELECT id,renewal_date FROM customer_services WHERE id=?", [payment.service_id])[0];
            if (!svc) return alert('Service not found');
            let current = new Date(svc[1]);
            // extend by payment type
            if (payment.payment_type === 'monthly') current.setMonth(current.getMonth() + 1);
            else current.setFullYear(current.getFullYear() + 1);
            const iso = current.toISOString().split('T')[0];
            try {
                this.run("UPDATE customer_services SET renewal_date=?, payment_status='active' WHERE id=?", [iso, payment.service_id]);
                this.run("UPDATE payments SET status='completed' WHERE id=?", [payment.id]);
                this.save(); this.reloadAll();
                alert('Renewal completed.');
            } catch (e) { alert('Error: ' + e.message); }
        },

        // helpers
        countServices(customerId) {
            const rows = this.all("SELECT COUNT(*) FROM customer_services WHERE customer_id=?", [customerId]);
            return rows.length ? rows[0][0] : 0;
        },
        getCustomerName(id) { const r = this.all("SELECT name FROM customers WHERE id=?", [id]); return r.length ? r[0][0] : 'Unknown'; },
        getServiceName(id) { const r = this.all("SELECT service_name FROM customer_services WHERE id=?", [id]); return r.length ? r[0][0] : 'Unknown'; },

        daysUntil(dateStr) { return this.calcDays(dateStr); },
        calcDays(dateStr) {
            const today = new Date(); const d = new Date(dateStr);
            const diff = Math.ceil((d - today) / (1000 * 60 * 60 * 24));
            return diff;
        },

        computeUpcoming() {
            const rows = this.all("SELECT id,customer_id,service_name,renewal_date FROM customer_services");
            const next = [];
            rows.forEach(r => {
                const days = this.calcDays(r[3]);
                if (days <= 30) {
                    next.push({ service: { id: r[0], customer_id: r[1], service_name: r[2], renewal_date: r[3] }, days });
                }
            });
            this.upcoming = next.sort((a, b) => a.days - b.days);
        },

        seedDemo() {
            if (!confirm('Seed demo data? This will overwrite existing DB.')) return;
            localStorage.removeItem('svc_db');
            location.reload();
        }

    };
}
