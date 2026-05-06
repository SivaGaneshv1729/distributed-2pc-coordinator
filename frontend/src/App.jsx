import React, { useState, useEffect } from 'react';
import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:3000';

function App() {
  const [transactions, setTransactions] = useState([]);
  const [sku, setSku] = useState('SKU123');
  const [qty, setQty] = useState(2);

  useEffect(() => {
    // Initial fetch
    axios.get(`${API_URL}/api/transactions`)
      .then(res => setTransactions(res.data))
      .catch(console.error);

    // WebSocket connection
    const ws = new WebSocket(WS_URL);
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'TRANSACTION_UPDATE') {
          setTransactions(prev => {
            const exists = prev.find(t => t.transaction_id === data.payload.transaction_id);
            if (exists) {
              return prev.map(t => t.transaction_id === data.payload.transaction_id 
                ? { ...t, status: data.payload.status } 
                : t);
            } else {
              return [{ transaction_id: data.payload.transaction_id, status: data.payload.status }, ...prev];
            }
          });
        }
      } catch (err) {
        console.error(err);
      }
    };

    return () => ws.close();
  }, []);

  const startTransaction = async () => {
    try {
      await axios.post(`${API_URL}/api/transactions`, {
        items: [{ sku, quantity: parseInt(qty) }]
      });
    } catch (err) {
      console.error(err);
    }
  };

  const startFailingTransaction = async () => {
    try {
      await axios.post(`${API_URL}/api/transactions`, {
        items: [{ sku: 'SKU456', quantity: 999 }] // Should fail
      });
    } catch (err) {
      console.error(err);
    }
  };

  const triggerChaos = async (serviceName) => {
    try {
      await axios.post(`${API_URL}/chaos/kill`, { service_name: serviceName });
      alert(`Sent kill signal to ${serviceName}`);
    } catch (err) {
      console.error(err);
      alert('Failed to kill container');
    }
  };

  const togglePause = async () => {
    try {
      const res = await axios.post(`${API_URL}/api/pause`);
      alert(`Coordinator pause before commit: ${res.data.paused}`);
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="container">
      <h1>2PC Transaction Monitor</h1>
      
      <div className="card">
        <h2>Start Transaction</h2>
        <div className="form-group">
          <label>SKU</label>
          <input value={sku} onChange={e => setSku(e.target.value)} />
        </div>
        <div className="form-group">
          <label>Quantity</label>
          <input type="number" value={qty} onChange={e => setQty(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button onClick={startTransaction}>Checkout</button>
          <button onClick={startFailingTransaction} style={{ backgroundColor: '#e67e22' }}>Checkout (Fail)</button>
          <button onClick={togglePause} style={{ backgroundColor: '#9b59b6' }}>Toggle Coordinator Pause</button>
        </div>
      </div>

      <div className="card">
        <h2>Transactions</h2>
        <div className="transaction-list" data-testid="transaction-list">
          {transactions.map(t => (
            <div key={t.transaction_id} className="transaction-item" data-testid={`transaction-item-${t.transaction_id}`}>
              <div>
                <strong>{t.transaction_id}</strong>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span 
                  className={`status-badge status-${t.status}`}
                  data-testid={`transaction-status-${t.transaction_id}`}
                >
                  {t.status}
                </span>
                
                {/* Show chaos button if in a vulnerable state */}
                {(t.status === 'PREPARING' || t.status === 'COMMITTING' || t.status === 'GLOBAL_COMMIT') && (
                  <button 
                    className="chaos" 
                    data-testid={`chaos-btn-${t.transaction_id}`}
                    onClick={() => triggerChaos('inventory-service')}
                  >
                    Kill Inventory
                  </button>
                )}
              </div>
            </div>
          ))}
          {transactions.length === 0 && <p>No transactions yet.</p>}
        </div>
      </div>
    </div>
  );
}

export default App;
