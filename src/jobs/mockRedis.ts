import { EventEmitter } from 'events';

// Map to keep track of registered workers by queue name
const mockWorkers = new Map<string, MockWorker>();

export class MockRedis extends EventEmitter {
  constructor() {
    super();
    // Simulate immediate connection success to satisfy BullMQ/app lifecycle
    setTimeout(() => {
      this.emit('connect');
      this.emit('ready');
    }, 10);
  }

  async ping() {
    return 'PONG';
  }

  async get() { return null; }
  async set() { return 'OK'; }
  async del() { return 0; }
  async eval() { return null; }
  async evalsha() { return null; }
  async quit() { return 'OK'; }
  async disconnect() {}
  
  defineCommand() {}
}

export class MockQueue {
  name: string;
  constructor(name: string, options?: any) {
    this.name = name;
  }

  async add(jobName: string, data: any, opts?: any) {
    console.log(`[MockQueue ${this.name}] Added job: ${jobName}`, data);
    
    // Find registered worker for this queue and process job in-process
    const worker = mockWorkers.get(this.name);
    if (worker) {
      setTimeout(async () => {
        try {
          await worker.processor({
            id: `mock-job-${Math.random().toString(36).substring(2, 9)}`,
            name: jobName,
            data,
            attemptsMade: 1,
            opts: opts || {},
          });
        } catch (err: any) {
          console.error(`[MockWorker ${this.name}] Job failed:`, err);
          worker.emit('failed', { id: `mock-job`, data, attemptsMade: 1, opts: opts || {} }, err);
        }
      }, 50);
    }
    return { id: 'mock-job-id', data };
  }

  async close() {}
}

export class MockWorker<T = any> extends EventEmitter {
  name: string;
  processor: Function;

  constructor(name: string, processor: Function, options?: any) {
    super();
    this.name = name;
    this.processor = processor;
    mockWorkers.set(name, this as any);
    console.log(`[MockWorker ${this.name}] Registered worker in-process`);
  }

  async close() {}
}
