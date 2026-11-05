import { io } from 'socket.io-client';

// Подключаемся к тому же хосту, где открыт сайт
export const socket = io();