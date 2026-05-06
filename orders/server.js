const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

const dbDir = path.join(__dirname, 'data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir);
}
const dbPath = path.join(dbDir, 'orders.db');

const db = new sqlite3.Database(dbPath);

// Initialize DB
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id VARCHAR(255) PRIMARY KEY,
      status VARCHAR(50) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS order_items (
      item_id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id VARCHAR(255),
      sku VARCHAR(50),
      quantity INTEGER,
      FOREIGN KEY(order_id) REFERENCES orders(order_id)
    )
  `);
});

const runQuery = (query, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(query, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
};

const getQuery = (query, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
};

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

app.post('/prepare', async (req, res) => {
  const { transaction_id, payload } = req.body;
  if (!transaction_id || !payload || !payload.items) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  try {
    const existingOrder = await getQuery('SELECT status FROM orders WHERE order_id = ?', [transaction_id]);
    if (existingOrder) {
      if (existingOrder.status === 'PREPARED') {
        return res.status(200).send();
      }
      return res.status(400).json({ error: 'Order exists with status: ' + existingOrder.status });
    }

    // Insert order as PREPARED
    await runQuery('BEGIN TRANSACTION');
    await runQuery('INSERT INTO orders (order_id, status) VALUES (?, ?)', [transaction_id, 'PREPARED']);
    
    for (const item of payload.items) {
      await runQuery('INSERT INTO order_items (order_id, sku, quantity) VALUES (?, ?, ?)', [transaction_id, item.sku, item.quantity]);
    }
    await runQuery('COMMIT');

    res.status(200).send();
  } catch (error) {
    await runQuery('ROLLBACK');
    res.status(500).json({ error: error.message });
  }
});

app.post('/commit', async (req, res) => {
  const { transaction_id } = req.body;

  try {
    const existingOrder = await getQuery('SELECT status FROM orders WHERE order_id = ?', [transaction_id]);
    if (existingOrder && existingOrder.status === 'COMMITTED') {
      return res.status(200).send(); // Idempotent
    }
    
    if (existingOrder && existingOrder.status === 'PREPARED') {
      await runQuery('UPDATE orders SET status = ? WHERE order_id = ?', ['COMMITTED', transaction_id]);
    } else if (!existingOrder) {
       // If not found, perhaps it was already deleted or never arrived. 
       // We can insert an empty committed record to satisfy idempotent recovery
       await runQuery('INSERT INTO orders (order_id, status) VALUES (?, ?)', [transaction_id, 'COMMITTED']);
    }
    res.status(200).send();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/rollback', async (req, res) => {
  const { transaction_id } = req.body;

  try {
    const existingOrder = await getQuery('SELECT status FROM orders WHERE order_id = ?', [transaction_id]);
    if (existingOrder && existingOrder.status === 'ROLLED_BACK') {
      return res.status(200).send(); // Idempotent
    }

    if (existingOrder && existingOrder.status === 'PREPARED') {
      await runQuery('UPDATE orders SET status = ? WHERE order_id = ?', ['ROLLED_BACK', transaction_id]);
    } else if (!existingOrder) {
       await runQuery('INSERT INTO orders (order_id, status) VALUES (?, ?)', [transaction_id, 'ROLLED_BACK']);
    }
    res.status(200).send();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => console.log(`Orders service listening on port ${PORT}`));
