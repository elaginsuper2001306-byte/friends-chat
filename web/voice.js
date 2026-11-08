// In-site voice: signaling goes over our WebSocket, audio goes straight between
// browsers (mesh). The room limit is small, so a full mesh stays affordable.
const MAX_RECONNECTS = 2;
const CONNECT_TIMEOUT_MS = 12_000;
const FALLBACK_STUN = [{ urls: ['stun:stun.sipnet.ru:3478', 'stun:stun.l.google.com:19302'] }];

const codeError = (code) => Object.assign(new Error(code), { code });

function microphone() {
  if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(codeError('mic_denied'));
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  }).catch((error) => {
    const name = error?.name;
    throw codeError(name === 'NotFoundError' || name === 'OverconstrainedError' ? 'mic_missing' : 'mic_denied');
  });
}

export function createVoiceEngine({ onPeers, onStatus, onError, onState, onAuthError } = {}) {
  const peers = new Map();
  const connections = new Map();
  let socket = null;
  let stream = null;
  let me = null;
  let channel = null;
  let iceServers = FALLBACK_STUN;
  let limit = 6;
  let phase = 'idle';
  let muted = false;
  let manualClose = false;
  let reconnects = 0;

  const notify = {
    peers: onPeers ?? (() => {}),
    status: onStatus ?? (() => {}),
    error: onError ?? (() => {}),
    state: onState ?? (() => {}),
    auth: onAuthError ?? (() => {}),
  };

  function setPhase(next) {
    if (phase === next) return;
    phase = next;
    notify.state(phase);
  }

  function publish() {
    const list = [];
    if (me) list.push({ ...me, self: true, muted });
    for (const peer of peers.values()) list.push({ ...peer, self: false });
    notify.peers(list, limit);
  }

  function sendSignal(to, data) {
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'signal', to, data }));
  }

  function send(message) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  function ensureConnection(id) {
    let conn = connections.get(id);
    if (conn) return conn;
    const pc = new RTCPeerConnection({ iceServers });
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.playsInline = true;
    audio.setAttribute('playsinline', '');
    audio.dataset.voicePeer = id;
    document.body.append(audio);
    conn = { pc, audio, pending: [], offered: false };
    connections.set(id, conn);
    for (const track of stream?.getAudioTracks() ?? []) pc.addTrack(track, stream);
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) sendSignal(id, { candidate: candidate.toJSON() });
    };
    pc.ontrack = ({ streams }) => {
      audio.srcObject = streams[0] ?? null;
      audio.play().catch(() => {});
    };
    return conn;
  }

  function closeConnection(id) {
    const conn = connections.get(id);
    if (!conn) return;
    connections.delete(id);
    try {
      conn.pc.close();
    } catch {
      // Already closed.
    }
    conn.audio.srcObject = null;
    conn.audio.remove();
  }

  function teardownConnections() {
    for (const id of [...connections.keys()]) closeConnection(id);
  }

  function shouldOffer(peerId) {
    return typeof me?.id === 'string' && String(me.id) < String(peerId);
  }

  async function offerTo(peerId) {
    if (!shouldOffer(peerId)) return;
    const conn = ensureConnection(peerId);
    if (conn.offered) return;
    conn.offered = true;
    try {
      const offer = await conn.pc.createOffer();
      await conn.pc.setLocalDescription(offer);
      sendSignal(peerId, { description: conn.pc.localDescription });
    } catch {
      conn.offered = false;
    }
  }

  function flushPending(conn) {
    const queue = conn.pending.splice(0);
    for (const candidate of queue) {
      conn.pc.addIceCandidate(candidate).catch(() => {});
    }
  }

  async function handleSignal(from, data) {
    if (!data || (!data.description && !data.candidate)) return;
    const conn = ensureConnection(from);
    try {
      if (data.description) {
        if (data.description.type === 'offer' && conn.pc.signalingState !== 'stable') {
          await conn.pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
        }
        await conn.pc.setRemoteDescription(data.description);
        flushPending(conn);
        if (data.description.type === 'offer') {
          const answer = await conn.pc.createAnswer();
          await conn.pc.setLocalDescription(answer);
          sendSignal(from, { description: conn.pc.localDescription });
        }
        return;
      }
      if (!conn.pc.remoteDescription) {
        conn.pending.push(data.candidate);
        return;
      }
      await conn.pc.addIceCandidate(data.candidate).catch(() => {});
    } catch {
      // A stale or superseded negotiation is safe to ignore.
    }
  }

  function applyJoined(message) {
    me = message.me ?? null;
    limit = Number.isInteger(message.limit) ? message.limit : 6;
    iceServers = Array.isArray(message.ice_servers) && message.ice_servers.length > 0
      ? message.ice_servers
      : FALLBACK_STUN;
    channel = message.channel ?? channel;
    peers.clear();
    for (const peer of message.peers ?? []) peers.set(peer.id, peer);
    reconnects = 0;
    for (const id of peers.keys()) void offerTo(id);
    publish();
    if (muted) send({ type: 'mute', muted: true });
    notify.status('');
  }

  function handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'peer-joined' && message.peer?.id) {
      peers.set(message.peer.id, message.peer);
      void offerTo(message.peer.id);
      publish();
      return;
    }
    if (message.type === 'peer-left' && message.peer_id) {
      peers.delete(message.peer_id);
      closeConnection(message.peer_id);
      publish();
      return;
    }
    if (message.type === 'peer-updated' && message.peer?.id) {
      if (message.peer.id === me?.id) return;
      peers.set(message.peer.id, { ...peers.get(message.peer.id), ...message.peer });
      publish();
      return;
    }
    if (message.type === 'signal' && typeof message.from === 'string') {
      void handleSignal(message.from, message.data);
      return;
    }
    if (message.type === 'error') {
      notify.status(message.code === 'voice_full'
        ? 'В комнате уже 6 человек. Попробуйте позже.'
        : 'Голосовая комната отклонила запрос.');
    }
  }

  function connect() {
    return new Promise((resolve, reject) => {
      if (!channel) {
        reject(codeError('voice_connect_failed'));
        return;
      }
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      let ws;
      try {
        ws = new WebSocket(`${scheme}://${location.host}/api/voice/socket`);
      } catch {
        reject(codeError('voice_connect_failed'));
        return;
      }
      socket = ws;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // Already closed.
        }
        finish(codeError('voice_connect_failed'));
      }, CONNECT_TIMEOUT_MS);

      ws.onopen = () => ws.send(JSON.stringify({ type: 'join', channel_id: channel.id }));
      ws.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === 'joined') {
          applyJoined(message);
          finish();
          return;
        }
        if (!settled) {
          if (message.type === 'error') {
            finish(codeError(message.code === 'voice_full' ? 'voice_full'
              : message.code === 'login_required' ? 'login_required' : 'voice_connect_failed'));
          }
          return;
        }
        handleMessage(message);
      };
      ws.onerror = () => finish(codeError('voice_connect_failed'));
      ws.onclose = (event) => {
        if (!settled) {
          finish(codeError(event.code === 4001 ? 'login_required'
            : event.code === 4003 ? 'voice_full' : 'voice_connect_failed'));
          return;
        }
        if (manualClose) return;
        if (event.code === 4004) {
          terminate();
          notify.error('voice_replaced');
          return;
        }
        if (event.code === 4001) {
          terminate();
          notify.auth();
          return;
        }
        void reconnect();
      };
    });
  }

  async function reconnect() {
    if (manualClose || phase === 'idle') return;
    if (reconnects >= MAX_RECONNECTS) {
      terminate();
      notify.error('voice_connect_failed');
      return;
    }
    reconnects += 1;
    teardownConnections();
    setPhase('connecting');
    notify.status('Связь с голосовой комнатой прервалась, переподключаемся…');
    await new Promise((done) => setTimeout(done, 1200 * reconnects));
    if (manualClose) return;
    try {
      await connect();
      setPhase('connected');
      notify.status('');
    } catch (error) {
      terminate();
      notify.error(error?.code === 'login_required' ? 'login_required' : 'voice_connect_failed');
    }
  }

  function stopStream() {
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
  }

  function terminate() {
    teardownConnections();
    const ws = socket;
    socket = null;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    }
    stopStream();
    peers.clear();
    me = null;
    channel = null;
    muted = false;
    limit = 6;
    reconnects = 0;
    setPhase('idle');
    publish();
  }

  return {
    get connected() {
      return phase === 'connected';
    },
    get connecting() {
      return phase === 'connecting';
    },
    get muted() {
      return muted;
    },
    get channelId() {
      return channel?.id ?? null;
    },
    get channelName() {
      return channel?.name ?? null;
    },
    async join(target) {
      if (!target?.id || phase !== 'idle') return false;
      channel = { id: target.id, name: target.name ?? '' };
      manualClose = false;
      reconnects = 0;
      setPhase('connecting');
      notify.status('Подключаемся к голосовому каналу…');
      try {
        if (!stream) stream = await microphone();
      } catch (error) {
        terminate();
        notify.error(error?.code ?? 'mic_denied');
        return false;
      }
      try {
        await connect();
      } catch (error) {
        terminate();
        notify.error(error?.code === 'login_required' ? 'login_required' : 'voice_connect_failed');
        return false;
      }
      setPhase('connected');
      notify.status('');
      return true;
    },
    leave() {
      manualClose = true;
      terminate();
    },
    toggleMute() {
      muted = !muted;
      for (const track of stream?.getAudioTracks() ?? []) track.enabled = !muted;
      send({ type: 'mute', muted });
      publish();
      return muted;
    },
  };
}
