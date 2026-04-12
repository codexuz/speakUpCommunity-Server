import { Response } from 'express';

interface SSEClient {
  id: string;
  userId: string;
  res: Response;
}

class SSEManager {
  private clients: Map<string, SSEClient> = new Map();

  addClient(clientId: string, userId: string, res: Response): void {
    res.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    this.clients.set(clientId, { id: clientId, userId, res });

    res.on('close', () => {
      this.clients.delete(clientId);
    });
  }

  sendToUser(userId: string, event: string, data: unknown): void {
    for (const client of this.clients.values()) {
      if (client.userId === userId) {
        client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    }
  }

  sendToUsers(userIds: string[], event: string, data: unknown): void {
    const idSet = new Set(userIds);
    for (const client of this.clients.values()) {
      if (idSet.has(client.userId)) {
        client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    }
  }

  broadcast(event: string, data: unknown): void {
    for (const client of this.clients.values()) {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  }

  getConnectionCount(): number {
    return this.clients.size;
  }
}

export const sseManager = new SSEManager();
