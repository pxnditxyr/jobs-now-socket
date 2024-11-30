const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const turso = require('./database'); // Importamos la conexión a Turso
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*', // Reemplaza '*' por tu dominio frontend en producción
    methods: ['GET', 'POST'],
  },
});

// Middleware para manejar la autenticación (opcional)
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (token) {
    socket.userId = token;
    next();
  } else {
    next(new Error('Autenticación fallida'));
  }
});

io.on('connection', (socket) => {
  console.log('Nuevo cliente conectado:', socket.id);

  // Unirse a una conversación específica
  socket.on('joinConversation', async (conversationId) => {
    try {
      console.log( 'llego joinConversation' )
      console.log({ conversationId })
      // Verificar si el usuario es participante de la conversación
      const isParticipant = await turso.execute({
        sql: `SELECT * FROM ConversationParticipant WHERE conversationId = ? AND userId = ? AND status = ?`,
        args: [conversationId, socket.userId, true],
      });

      if (isParticipant.rows.length > 0) {
        socket.join(conversationId);
        console.log(`Socket ${socket.id} se unió a la conversación ${conversationId}`);
      } else {
        socket.emit('errorMessage', { error: 'No tienes acceso a esta conversación.' });
      }
    } catch (error) {
      console.error('Error al unirse a la conversación:', error);
      socket.emit('errorMessage', { error: 'Error al unirse a la conversación.' });
    }
  });

  // Escuchar mensajes enviados por el cliente
  socket.on('sendMessage', async (message) => {
    console.log( 'llego mensaje' )
    const { conversationId, content, messageType = 'text', attachmentUrl = null } = message;
    const senderId = socket.userId;

    if (!senderId) {
      socket.emit('errorMessage', { error: 'Usuario no autenticado.' });
      return;
    }
    console.log({ message, senderId })

    try {
      console.log( 'entra al try' )

      const conversationResult = await turso.execute({
        sql: `SELECT * FROM Conversation WHERE id = ?`,
        args: [conversationId],
      })

      const participantResult = await turso.execute({
        sql: `SELECT * FROM ConversationParticipant WHERE conversationId = ? AND userId = ? AND status = ?`,
        args: [conversationId, senderId, true],
      })

      if (conversationResult.rows.length === 0) {
        socket.emit('errorMessage', { error: 'La conversación no existe.' });
        return;
      }

      if (participantResult.rows.length === 0) {
        socket.emit('errorMessage', { error: 'No eres participante de esta conversación.' });
        return;
      }

      //// Insertar el mensaje en la base de datos
      const messageId = uuidv4();
      const timestamp = new Date().toISOString();

      // Iniciar una transacción
      //await turso.batch(async (tx) => {
      //  await tx.execute({
      //    sql: `INSERT INTO Message (id, conversationId, senderId, content, messageType, attachmentUrl, createdAt, updatedAt, status)
      //          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      //    args: [messageId, conversationId, senderId, content, messageType, attachmentUrl, timestamp, timestamp, true],
      //  });
      //
      //  await tx.execute({
      //    sql: `INSERT INTO MessageStatus (id, messageId, userId, isRead, readAt, createdAt, updatedAt)
      //          VALUES (?, ?, ?, ?, ?, ?, ?)`,
      //    args: [uuidv4(), messageId, senderId, false, null, timestamp, timestamp],
      //  });
      //});

      const result = await turso.batch(
        [
          {
            sql: `INSERT INTO Message (id, conversationId, senderId, content, messageType, attachmentUrl, createdAt, updatedAt, status)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [ messageId, conversationId, senderId, content, messageType, attachmentUrl, timestamp, timestamp, true ],
          },
          {
            sql: `INSERT INTO MessageStatus (id, messageId, userId, isRead, readAt, createdAt, updatedAt)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [ uuidv4(), messageId, senderId, false, null, timestamp, timestamp ],
          }
        ]
      )

      console.log({ result })

      // Construir el mensaje para enviar a los clientes
      const savedMessage = {
        id: messageId,
        conversationId,
        senderId,
        content,
        messageType,
        attachmentUrl,
        createdAt: timestamp,
        updatedAt: timestamp,
        status: true,
        state: 'delivered',
      };

      // Emitir el mensaje a todos los clientes en la misma conversación
      io.to(conversationId).emit('receiveMessage', savedMessage);
    } catch (error) {
      console.error('Error al guardar el mensaje:', error);
      socket.emit('errorMessage', { error: 'No se pudo enviar el mensaje.' });
    }
  });

  // Obtener mensajes de una conversación
  socket.on('getConversationMessages', async ({ conversationId, limit = 50, offset = 0 }) => {
    try {
      console.log( 'llego getConversationMessages' )
      console.log({ conversationId, limit, offset })

      const messagesResult = await turso.execute({
        sql: `
          SELECT m.*, ms.isRead, ms.readAt
          FROM Message m
          INNER JOIN MessageStatus ms ON m.id = ms.messageId
          WHERE m.conversationId = ? AND m.status = ?
          ORDER BY m.createdAt ASC
          LIMIT ? OFFSET ?
        `,
        args: [conversationId, true, limit, offset],
      });

      const messages = messagesResult.rows.map((row) => ({
        ...row,
        state: row.isRead ? 'read' : 'delivered',
      }));

      socket.emit('conversationMessages', { messages });
    } catch (error) {
      console.error('Error al obtener mensajes:', error);
      socket.emit('errorMessage', { error: 'Error al obtener mensajes.' });
    }
  });

  // Obtener conversaciones del usuario
  socket.on('getUserConversations', async () => {
    console.log( 'llego getUserConversations' )

    const userId = socket.userId;

    try {
      const conversationsResult = await turso.execute({
        sql: `
          SELECT c.*
          FROM Conversation c
          INNER JOIN ConversationParticipant cp ON c.id = cp.conversationId
          WHERE cp.userId = ? AND c.status = ?
          ORDER BY c.updatedAt DESC
        `,
        args: [userId, true],
      });

      const conversations = await Promise.all(
        conversationsResult.rows.map(async (conversation) => {
          const participantsResult = await turso.execute({
            sql: `
              SELECT u.id, u.name, u.lastName, u.avatar
              FROM ConversationParticipant cp
              INNER JOIN User u ON cp.userId = u.id
              WHERE cp.conversationId = ? AND cp.status = ?
            `,
            args: [conversation.id, true],
          });

          return {
            ...conversation,
            participants: participantsResult.rows,
          };
        })
      );

      socket.emit('userConversations', { conversations });
    } catch (error) {
      console.error('Error al obtener conversaciones:', error);
      socket.emit('errorMessage', { error: 'Error al obtener conversaciones.' });
    }
  });

  socket.on('disconnect', () => {
    console.log('Cliente desconectado:', socket.id);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Servidor Socket.IO corriendo en puerto ${PORT}`);
});
