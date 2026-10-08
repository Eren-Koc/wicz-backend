const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
app.use(cors());

const PORT = process.env.PORT || 5008;
const FRONTEND_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:4173",
  "https://goruselim.com"
];

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: FRONTEND_ORIGINS,
    methods: ["GET", "POST"]
  }
});

const rooms = new Map();

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function roomChannel(code) {
  return `screen:${code}`;
}

function leaveViewer(socket, notifyHost = true) {
  const code = socket.screenRoom;
  if (!code) return;

  const room = rooms.get(code);
  socket.leave(roomChannel(code));
  socket.screenRoom = null;
  socket.screenRole = null;

  if (!room) return;

  if (room.hostId === socket.id) return;

  room.viewers.delete(socket.id);
  if (notifyHost && room.hostId) {
    io.to(room.hostId).emit("viewer-left", { viewerId: socket.id });
  }

  if (!room.hostId && room.viewers.size === 0) {
    rooms.delete(code);
  }
}

function endHostRoom(socket, reason = "host-left") {
  const code = socket.screenRoom;
  if (!code) return;

  const room = rooms.get(code);
  if (!room || room.hostId !== socket.id) return;

  io.to(roomChannel(code)).emit("host-left", { reason });
  rooms.delete(code);
  socket.leave(roomChannel(code));
  socket.screenRoom = null;
  socket.screenRole = null;
}

io.on("connection", (socket) => {
  socket.on("create-room", ({ uid } = {}, callback) => {
    if (socket.screenRoom) {
      callback?.({ ok: false, error: "Zaten bir odadasınız." });
      return;
    }

    const code = generateRoomCode();
    rooms.set(code, {
      code,
      hostId: socket.id,
      hostUid: uid || socket.id,
      viewers: new Set(),
      createdAt: Date.now()
    });

    socket.screenRoom = code;
    socket.screenRole = "host";
    socket.join(roomChannel(code));

    callback?.({ ok: true, code });
    socket.emit("room-created", { code });
  });

  socket.on("join-room", ({ code, uid } = {}, callback) => {
    const normalizedCode = String(code || "").trim().toUpperCase();
    const room = rooms.get(normalizedCode);

    if (!room) {
      callback?.({ ok: false, error: "Bu yayın kodu bulunamadı veya yayın sona erdi." });
      return;
    }

    if (room.hostId === socket.id) {
      callback?.({ ok: false, error: "Yayın sahibi olarak zaten odadasınız." });
      return;
    }

    if (room.viewers.size >= 20) {
      callback?.({ ok: false, error: "Bu yayın şu anda dolu." });
      return;
    }

    if (socket.screenRoom) {
      leaveViewer(socket, false);
      endHostRoom(socket, "replaced");
    }

    room.viewers.add(socket.id);
    socket.screenRoom = normalizedCode;
    socket.screenRole = "viewer";
    socket.screenUid = uid || socket.id;
    socket.join(roomChannel(normalizedCode));

    callback?.({ ok: true, code: normalizedCode, hostId: room.hostId });
    socket.emit("room-joined", {
      code: normalizedCode,
      hostId: room.hostId,
      viewerCount: room.viewers.size
    });
    io.to(room.hostId).emit("viewer-joined", {
      viewerId: socket.id,
      viewerUid: socket.screenUid,
      viewerCount: room.viewers.size
    });
  });

  socket.on("offer", ({ to, sdp } = {}) => {
    if (to && sdp) io.to(to).emit("offer", { from: socket.id, sdp });
  });

  socket.on("answer", ({ to, sdp } = {}) => {
    if (to && sdp) io.to(to).emit("answer", { from: socket.id, sdp });
  });

  socket.on("ice-candidate", ({ to, candidate } = {}) => {
    if (to && candidate) io.to(to).emit("ice-candidate", { from: socket.id, candidate });
  });

  socket.on("leave-room", () => {
    if (socket.screenRole === "host") {
      endHostRoom(socket, "host-left");
    } else {
      leaveViewer(socket, true);
    }
  });

  socket.on("stop-sharing", () => {
    if (socket.screenRole !== "host") return;
    const code = socket.screenRoom;
    if (!code) return;
    io.to(roomChannel(code)).emit("stream-ended");
  });

  socket.on("disconnect", () => {
    if (socket.screenRole === "host") {
      endHostRoom(socket, "disconnect");
    } else {
      leaveViewer(socket, true);
    }
  });
});

app.get("/", (_req, res) => {
  res.json({ ok: true, service: "Görüşelim Screen Share", rooms: rooms.size });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

server.listen(PORT, () => {
  console.log(`Screen-share server running on port ${PORT}`);
});
