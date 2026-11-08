import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceRooms } from '../server/voice-rooms.mjs';

function entry(name) {
  const inbox = [];
  const closes = [];
  return {
    inbox,
    closes,
    meta: { name },
    muted: false,
    send: (message) => inbox.push(message),
    close: (code) => closes.push(code),
  };
}

test('join returns self and existing peers, others get peer-joined', () => {
  const rooms = createVoiceRooms();
  const a = entry('Аня');
  const first = rooms.join('ch1', 'a', a);
  assert.equal(first.ok, true);
  assert.equal(first.self.name, 'Аня');
  assert.equal(first.self.self, true);
  assert.equal(first.self.muted, false);
  assert.deepEqual(first.peers, []);
  assert.equal(rooms.size('ch1'), 1);

  const b = entry('Боря');
  const second = rooms.join('ch1', 'b', b);
  assert.deepEqual(second.peers.map((peer) => peer.id), ['a']);
  assert.equal(a.inbox.length, 1);
  assert.equal(a.inbox[0].type, 'peer-joined');
  assert.equal(a.inbox[0].peer.name, 'Боря');
});

test('room rejects a seventh participant and keeps six', () => {
  const rooms = createVoiceRooms();
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
    assert.equal(rooms.join('ch1', id, entry(id)).ok, true);
  }
  assert.equal(rooms.size('ch1'), 6);
  const seventh = rooms.join('ch1', 'g', entry('Г'));
  assert.deepEqual(seventh, { ok: false, code: 'voice_full' });
  assert.equal(rooms.size('ch1'), 6);
});

test('the same user replaces an old connection instead of taking a second seat', () => {
  const rooms = createVoiceRooms();
  const old = entry('Аня');
  rooms.join('ch1', 'a', old);
  const fresh = entry('Аня');
  const result = rooms.join('ch1', 'a', fresh);
  assert.equal(result.ok, true);
  assert.equal(result.replaced, true);
  assert.deepEqual(old.closes, [4004]);
  assert.equal(rooms.size('ch1'), 1);
  assert.deepEqual(result.peers, []);
});

test('signals reach only the addressed peer in the same channel', () => {
  const rooms = createVoiceRooms();
  const a = entry('Аня');
  const b = entry('Боря');
  rooms.join('ch1', 'a', a);
  rooms.join('ch1', 'b', b);
  rooms.join('ch2', 'c', entry('Соня'));

  assert.equal(rooms.signal('ch1', 'a', 'b', { description: { type: 'offer', sdp: 'x' } }), true);
  assert.equal(b.inbox.at(-1).type, 'signal');
  assert.equal(b.inbox.at(-1).from, 'a');
  assert.equal(rooms.signal('ch1', 'a', 'c', { candidate: null }), false);
  assert.equal(rooms.signal('ch2', 'a', 'b', { candidate: null }), false);
  assert.equal(b.inbox.filter((message) => message.type === 'signal').length, 1);
});

test('mute state is broadcast to the room', () => {
  const rooms = createVoiceRooms();
  const a = entry('Аня');
  const b = entry('Боря');
  rooms.join('ch1', 'a', a);
  rooms.join('ch1', 'b', b);
  assert.equal(rooms.setMuted('ch1', 'b', true), true);
  const update = a.inbox.at(-1);
  assert.equal(update.type, 'peer-updated');
  assert.equal(update.peer.id, 'b');
  assert.equal(update.peer.muted, true);
});

test('a stale connection cannot remove the fresh one or empty room', () => {
  const rooms = createVoiceRooms();
  const old = entry('Аня');
  const current = entry('Аня');
  rooms.join('ch1', 'a', old);
  rooms.join('ch1', 'a', current);
  assert.equal(rooms.leave('ch1', 'a', old), false);
  assert.equal(rooms.size('ch1'), 1);
  assert.equal(rooms.leave('ch1', 'b'), false);
});
