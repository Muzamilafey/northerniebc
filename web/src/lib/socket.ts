import { io, type Socket } from 'socket.io-client';
import { getToken } from './api';

let socket: Socket | null = null;
export function getSocket(): Socket {
  if (!socket) {
    socket = io({ path: '/socket.io', transports: ['websocket', 'polling'], auth: (cb) => cb({ token: getToken() ?? undefined }) });
  }
  return socket;
}
