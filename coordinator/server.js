const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());

// Allow CORS for frontend
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

const INVENTORY_URL = process.env.INVENTORY_URL || 'http://localhost:3001';
const ORDERS_URL = process.env.ORDERS_URL || 'http://localhost:3002';
const WAL_PATH = path.join(__dirname, 'data', 'coordinator.log');

const transactions = new Map();

// Helper to broadcast WS messages
const broadcast = (txId, status) => {
  const msg = JSON.stringify({
    type: 'TRANSACTION_UPDATE',
    payload: {
      transaction_id: txId,
      status,
      timestamp: new Date().toISOString()
    }
  });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
};

// Helper to write to WAL
const writeWAL = (txId, state, payload = null) => {
  const entry = { timestamp: new Date().toISOString(), transaction_id: txId, state };
  if (payload) entry.payload = payload;
  
  // Update in-memory state
  if (transactions.has(txId)) {
    transactions.get(txId).status = state;
  } else {
    transactions.set(txId, { status: state, payload });
  }

  // Append to log synchronously to ensure durability
  fs.appendFileSync(WAL_PATH, JSON.stringify(entry) + '\n');
  
  // Broadcast update
  broadcast(txId, state);
};

// Recover from WAL
const recover = async () => {
  if (!fs.existsSync(WAL_PATH)) {
    // Create dir if not exists
    const dir = path.dirname(WAL_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return;
  }

  const lines = fs.readFileSync(WAL_PATH, 'utf-8').split('\n').filter(Boolean);
  const stateMap = new Map();
  const payloadMap = new Map();

  lines.forEach(line => {
    try {
      const entry = JSON.parse(line);
      stateMap.set(entry.transaction_id, entry.state);
      if (entry.payload) payloadMap.set(entry.transaction_id, entry.payload);
    } catch (e) {}
  });

  for (const [txId, state] of stateMap.entries()) {
    transactions.set(txId, { status: state, payload: payloadMap.get(txId) });

    if (state === 'BEGIN' || state === 'PREPARING') {
      console.log(`Recovering: ${txId} was in ${state}, moving to GLOBAL_ABORT`);
      writeWAL(txId, 'GLOBAL_ABORT');
      await rollbackTransaction(txId);
      writeWAL(txId, 'END');
    } else if (state === 'GLOBAL_COMMIT') {
      console.log(`Recovering: ${txId} was in GLOBAL_COMMIT, re-sending commit`);
      await commitTransaction(txId);
      writeWAL(txId, 'END');
    } else if (state === 'GLOBAL_ABORT') {
      console.log(`Recovering: ${txId} was in GLOBAL_ABORT, re-sending rollback`);
      await rollbackTransaction(txId);
      writeWAL(txId, 'END');
    }
  }
};

const callParticipant = async (url, txId, payload = null) => {
  try {
    const data = { transaction_id: txId };
    if (payload) data.payload = payload;
    await axios.post(url, data, { timeout: 10000 });
    return true;
  } catch (err) {
    console.error(`Error calling ${url} for ${txId}:`, err.message);
    return false;
  }
};

const commitTransaction = async (txId) => {
  await Promise.all([
    callParticipant(`${INVENTORY_URL}/commit`, txId),
    callParticipant(`${ORDERS_URL}/commit`, txId)
  ]);
};

const rollbackTransaction = async (txId) => {
  await Promise.all([
    callParticipant(`${INVENTORY_URL}/rollback`, txId),
    callParticipant(`${ORDERS_URL}/rollback`, txId)
  ]);
};

// Special variable to pause execution for testing recovery
let pauseBeforeCommit = false;

app.post('/api/pause', (req, res) => {
  pauseBeforeCommit = !pauseBeforeCommit;
  res.send({ paused: pauseBeforeCommit });
});

app.post('/api/transactions', async (req, res) => {
  const { items } = req.body;
  if (!items || !Array.isArray(items)) return res.status(400).json({ error: 'Invalid items' });

  const txId = `txn-${uuidv4()}`;
  writeWAL(txId, 'BEGIN', { items });
  writeWAL(txId, 'PREPARING');

  const inventoryVote = callParticipant(`${INVENTORY_URL}/prepare`, txId, { items });
  const ordersVote = callParticipant(`${ORDERS_URL}/prepare`, txId, { items });

  const [invSuccess, ordSuccess] = await Promise.all([inventoryVote, ordersVote]);

  if (invSuccess && ordSuccess) {
    writeWAL(txId, 'GLOBAL_COMMIT');
    
    if (pauseBeforeCommit) {
      console.log(`Paused execution for ${txId} after GLOBAL_COMMIT`);
      return res.status(202).json({ transaction_id: txId, status: 'PAUSED' });
    }

    writeWAL(txId, 'COMMITTING');
    await commitTransaction(txId);
    writeWAL(txId, 'END');
    
    // The final state returned in REST represents the final decision
    return res.status(201).json({ transaction_id: txId, status: 'COMMITTED' });
  } else {
    writeWAL(txId, 'GLOBAL_ABORT');
    writeWAL(txId, 'ABORTING');
    await rollbackTransaction(txId);
    writeWAL(txId, 'END');
    
    return res.status(409).json({ transaction_id: txId, status: 'ABORTED', reason: 'Participant voted ABORT or failed' });
  }
});

app.get('/api/transactions', (req, res) => {
  const result = [];
  for (const [txId, data] of transactions.entries()) {
    result.push({ transaction_id: txId, status: data.status });
  }
  res.json(result);
});

app.get('/api/transactions/:id', (req, res) => {
  const txId = req.params.id;
  if (!transactions.has(txId)) return res.status(404).json({ error: 'Not found' });
  res.json({ transaction_id: txId, status: transactions.get(txId).status });
});

app.get('/health', (req, res) => res.send('OK'));

app.post('/chaos/kill', (req, res) => {
  const { service_name } = req.body;
  if (!service_name) return res.status(400).json({ error: 'service_name required' });

  // Use docker API via curl
  // Find the container ID first or just use the likely service name prefix from docker-compose.
  // We can use `docker ps` to find the container matching the service name and kill it.
  exec(`docker ps -q -f "name=${service_name}"`, (err, stdout) => {
    if (err) return res.status(500).json({ error: err.message });
    const containerId = stdout.trim().split('\\n')[0];
    if (!containerId) return res.status(404).json({ error: 'Container not found' });
    
    exec(`docker kill ${containerId}`, (err2) => {
      if (err2) return res.status(500).json({ error: err2.message });
      res.json({ success: true, killed: containerId });
    });
  });
});

const PORT = process.env.PORT || 3000;

recover().then(() => {
  server.listen(PORT, () => console.log(`Coordinator running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to recover', err);
  process.exit(1);
});
