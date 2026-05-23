import { Server as SocketIOServer } from 'socket.io';

let ioInstance: SocketIOServer | null = null;

export const setIoInstance = (io: SocketIOServer) => {
  ioInstance = io;
};

export const getIoInstance = (): SocketIOServer => {
  if (!ioInstance) {
    throw new Error('Socket.IO instance is not initialized yet.');
  }
  return ioInstance;
};
