# Transactional Inventory System with 2-Phase Commit (2PC)

This project demonstrates a distributed inventory and order processing system utilizing the Two-Phase Commit (2PC) protocol to guarantee data consistency across microservices with heterogeneous data stores (PostgreSQL and SQLite). 

## Running the Application

To start the entire application, use Docker Compose from the root directory:

```bash
docker-compose up --build
```

### Services Included
- **Coordinator Service** (Port 3000): Central brain of the 2PC protocol.
- **Inventory Service** (Port 3001): Manages product stock (PostgreSQL).
- **Orders Service** (Port 3002): Manages order records (SQLite).
- **Frontend Monitor UI** (Port 5173): React dashboard for real-time visualization.
- **Inventory Database** (Port 5432): PostgreSQL instance containing product data.

## Analysis and Architectural Considerations

### The Blocking Problem in 2PC
Two-Phase Commit provides strong consistency (atomicity), ensuring that all participants either commit or abort. However, 2PC's fundamental weakness is **The Blocking Problem**. 

If the transaction coordinator crashes after Phase 1 (Prepare) has successfully completed, but before it can write the final `GLOBAL_COMMIT` or `GLOBAL_ABORT` decision to its Write-Ahead Log (WAL) and inform the participants, the participants are left in a "blocked" or "in-doubt" state. 

While in this state, participants hold exclusive database locks on the resources (e.g., inventory rows) involved in the transaction. Because they cannot independently decide to commit or abort without risking data inconsistency, they must wait indefinitely until the coordinator recovers and communicates the final decision. During this downtime, any other transaction attempting to modify those locked resources will be blocked, causing severe availability issues for the entire system.

### 2PC vs. Saga Pattern
When designing distributed systems, architects must choose between strong consistency (2PC) and high availability (Sagas).

| Feature | Two-Phase Commit (2PC) | Saga Pattern |
| :--- | :--- | :--- |
| **Consistency** | Strong (Atomicity) | Eventual Consistency |
| **Availability** | Lower (due to the Blocking Problem) | Higher (Services operate independently) |
| **Performance** | Slower (requires locking resources) | Faster (local transactions only) |
| **Rollback** | Automatic (handled by DB engine) | Manual (Requires compensating transactions) |

**When to use 2PC:**
- Ideal for use cases requiring absolute atomic consistency, where intermediate or eventual consistency is unacceptable.
- Common in financial systems, legacy databases, or short-lived transactions spanning a small number of internal microservices on a reliable network.

**When to use Sagas:**
- Ideal for long-running business processes spanning multiple domains where holding locks is impractical.
- Better suited for highly available e-commerce systems, microservices architectures, and integrations with third-party APIs that do not support 2PC protocols. 

In the Saga pattern, if a step fails, the system executes a series of compensating transactions to undo the previous successful steps. While it requires more complex application logic to handle compensations, it completely avoids the distributed blocking problem inherent to 2PC.
