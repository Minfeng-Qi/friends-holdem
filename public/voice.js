'use strict';
// 房间内 WebRTC 点对点语音（mesh）。信令走 Socket.IO，音频端到端直传，服务器不经手音频。
(function () {
  const socket = window.gameSocket;
  const myId = () => (window.getPlayerId ? window.getPlayerId() : null);
  const $ = id => document.getElementById(id);
  const RTC = { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ] };

  let joined = false, localStream = null, ac = null;
  const peers = {};    // peerId -> RTCPeerConnection
  const audios = {};   // peerId -> <audio>
  const monitors = {}; // pid -> {an, data, src}
  window.voiceOn = new Set();
  window.voiceSpeaking = new Set();

  async function join() {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false,
      });
    } catch (e) { toast('麦克风打开失败：' + (e.message || e.name)); return; }
    joined = true;
    monitor(myId(), localStream);
    socket.emit('voice-join');
    updateBtn();
  }
  function leave() {
    joined = false;
    socket.emit('voice-leave');
    Object.keys(peers).forEach(closePeer);
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    stopMonitor(myId());
    updateBtn();
  }
  function toggle() { joined ? leave() : join(); }

  function pc(peerId) {
    if (peers[peerId]) return peers[peerId];
    const p = new RTCPeerConnection(RTC);
    peers[peerId] = p;
    if (localStream) localStream.getTracks().forEach(t => p.addTrack(t, localStream));
    p.onicecandidate = e => { if (e.candidate) socket.emit('voice-signal', { to: peerId, data: { ice: e.candidate } }); };
    p.ontrack = e => attachAudio(peerId, e.streams[0]);
    p.onconnectionstatechange = () => { if (['failed', 'closed'].includes(p.connectionState)) closePeer(peerId); };
    return p;
  }
  async function startOffer(peerId) {
    if (!joined || !localStream) return;
    const p = pc(peerId);
    try {
      const o = await p.createOffer();
      await p.setLocalDescription(o);
      socket.emit('voice-signal', { to: peerId, data: { sdp: p.localDescription } });
    } catch (e) {}
  }
  function closePeer(peerId) {
    if (peers[peerId]) { try { peers[peerId].close(); } catch {} delete peers[peerId]; }
    if (audios[peerId]) { try { audios[peerId].srcObject = null; audios[peerId].remove(); } catch {} delete audios[peerId]; }
    stopMonitor(peerId);
  }
  function attachAudio(peerId, stream) {
    let a = audios[peerId];
    if (!a) { a = document.createElement('audio'); a.autoplay = true; a.playsInline = true; a.style.display = 'none'; document.body.appendChild(a); audios[peerId] = a; }
    a.srcObject = stream; a.play && a.play().catch(() => {});
    monitor(peerId, stream);
  }

  // —— 说话检测 ——
  function monitor(pid, stream) {
    try {
      if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
      const src = ac.createMediaStreamSource(stream);
      const an = ac.createAnalyser(); an.fftSize = 512; src.connect(an);
      monitors[pid] = { an, data: new Uint8Array(an.fftSize), src };
    } catch {}
  }
  function stopMonitor(pid) { if (monitors[pid]) { try { monitors[pid].src.disconnect(); } catch {} delete monitors[pid]; } window.voiceSpeaking.delete(pid); }
  setInterval(() => {
    let changed = false;
    for (const pid in monitors) {
      const m = monitors[pid]; m.an.getByteTimeDomainData(m.data);
      let sum = 0; for (let i = 0; i < m.data.length; i++) { const x = (m.data[i] - 128) / 128; sum += x * x; }
      const talking = Math.sqrt(sum / m.data.length) > 0.05;
      if (talking !== window.voiceSpeaking.has(pid)) { talking ? window.voiceSpeaking.add(pid) : window.voiceSpeaking.delete(pid); changed = true; }
    }
    if (changed && window.applyVoiceUI) window.applyVoiceUI();
  }, 160);

  // —— 信令 ——
  socket.on('voice-initiate', ({ peer }) => { if (joined) startOffer(peer); });
  socket.on('voice-signal', async ({ from, data }) => {
    if (!joined) return;
    const p = pc(from);
    try {
      if (data.sdp) {
        await p.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          const ans = await p.createAnswer(); await p.setLocalDescription(ans);
          socket.emit('voice-signal', { to: from, data: { sdp: p.localDescription } });
        }
      } else if (data.ice) { try { await p.addIceCandidate(data.ice); } catch {} }
    } catch (e) {}
  });
  socket.on('voice-peer-left', ({ peerId }) => closePeer(peerId));
  socket.on('voice-state', ({ peers: list }) => { window.voiceOn = new Set(list || []); if (window.applyVoiceUI) window.applyVoiceUI(); updateBtn(); });

  // —— UI ——
  window.applyVoiceUI = function () {
    document.querySelectorAll('.seat[data-pid]').forEach(seat => {
      const pid = seat.dataset.pid;
      const plate = seat.querySelector('.plate'); if (!plate) return;
      seat.classList.toggle('speaking', window.voiceSpeaking.has(pid));
      const want = window.voiceOn.has(pid);
      let b = plate.querySelector('.voice-badge');
      if (want && !b) { b = document.createElement('div'); b.className = 'voice-badge'; b.textContent = '🎤'; plate.appendChild(b); }
      else if (!want && b) { b.remove(); }
    });
  };
  function updateBtn() {
    const btn = $('voiceBtn'); if (!btn) return;
    btn.classList.toggle('on', joined);
    btn.textContent = joined ? '🎤' : '🎙️';
    btn.title = joined ? '语音已开（点击关闭麦克风）' : '开启语音';
  }
  function toast(t) { const el = $('toast'); if (!el) return; el.textContent = t; el.classList.remove('hidden'); setTimeout(() => el.classList.add('hidden'), 2600); }

  window.__voiceStats = () => ({
    joined,
    peers: Object.keys(peers).length,
    audios: Object.keys(audios).length,
    states: Object.fromEntries(Object.entries(peers).map(([k, p]) => [k, p.connectionState])),
    on: [...window.voiceOn],
  });

  const vb = $('voiceBtn'); if (vb) vb.onclick = toggle;
  updateBtn();
})();
