import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, createTask, updateTask, calculateDailyStats, calculateWeeklyStats, calculateStreak, getSessionsForDate, getSessionsForTask, formatDuration, validateSession, validateTask, getNotificationSettings } from '../src/logic.js';

test('createSession creates valid session', () => {
  const session = createSession({ taskId: '123', duration: 1500000, type: 'work', date: new Date() });
  assert.equal(session.taskId, '123');
  assert.equal(session.duration, 1500000);
  assert.equal(session.type, 'work');
});

test('createSession throws on invalid data', () => {
  assert.throws(() => createSession({ taskId: null, duration: 1500000, type: 'work', date: new Date() }));
  assert.throws(() => createSession({ taskId: '123', duration: -1000, type: 'work', date: new Date() }));
  assert.throws(() => createSession({ taskId: '123', duration: 1500000, type: 'invalid', date: new Date() }));
});

test('createTask creates valid task', () => {
  const task = createTask({ name: 'Test Task' });
  assert.ok(task.id);
  assert.equal(task.name, 'Test Task');
  assert.equal(task.completed, false);
});

test('createTask throws on invalid name', () => {
  assert.throws(() => createTask({ name: null }));
  assert.throws(() => createTask({ name: '' }));
});

test('updateTask returns updates', () => {
  const updates = { name: 'Updated Task', completed: true };
  const result = updateTask('123', updates);
  assert.equal(result.name, 'Updated Task');
  assert.equal(result.completed, true);
});

test('calculateDailyStats works correctly', () => {
  const sessions = [
    createSession({ taskId: '1', duration: 1500000, type: 'work', date: new Date('2023-01-01') }),
    createSession({ taskId: '2', duration: 300000, type: 'break', date: new Date('2023-01-01') })
  ];
  const stats = calculateDailyStats(sessions, new Date('2023-01-01'));
  assert.equal(stats.totalWorkDuration, 1500000);
  assert.equal(stats.totalSessions, 2);
  assert.equal(stats.workSessionsCount, 1);
});

test('calculateWeeklyStats works correctly', () => {
  const sessions = [
    createSession({ taskId: '1', duration: 1500000, type: 'work', date: new Date('2023-01-01') }),
    createSession({ taskId: '2', duration: 300000, type: 'break', date: new Date('2023-01-01') })
  ];
  const stats = calculateWeeklyStats(sessions, new Date('2023-01-01'));
  assert.equal(stats.totalWorkDuration, 1500000);
  assert.equal(stats.totalSessions, 2);
  assert.equal(stats.workSessionsCount, 1);
});

test('calculateStreak works correctly', () => {
  const sessions = [
    createSession({ taskId: '1', duration: 1500000, type: 'work', date: new Date('2023-01-01') }),
    createSession({ taskId: '2', duration: 1500000, type: 'work', date: new Date('2023-01-02') }),
    createSession({ taskId: '3', duration: 1500000, type: 'work', date: new Date('2023-01-03') })
  ];
  const streak = calculateStreak(sessions);
  assert.equal(streak, 3);
});

test('getSessionsForDate filters correctly', () => {
  const sessions = [
    createSession({ taskId: '1', duration: 1500000, type: 'work', date: new Date('2023-01-01') }),
    createSession({ taskId: '2', duration: 1500000, type: 'work', date: new Date('2023-01-02') })
  ];
  const filtered = getSessionsForDate(sessions, new Date('2023-01-01'));
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].taskId, '1');
});

test('getSessionsForTask filters correctly', () => {
  const sessions = [
    createSession({ taskId: '1', duration: 1500000, type: 'work', date: new Date('2023-01-01') }),
    createSession({ taskId: '2', duration: 1500000, type: 'work', date: new Date('2023-01-01') })
  ];
  const filtered = getSessionsForTask(sessions, '1');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].taskId, '1');
});

test('formatDuration formats correctly', () => {
  assert.equal(formatDuration(1500000), '25:00');
  assert.equal(formatDuration(60000), '01:00');
});

test('validateSession returns true for valid session', () => {
  const session = { taskId: '123', duration: 1500000, type: 'work', date: new Date() };
  assert.equal(validateSession(session), true);
});

test('validateSession returns false for invalid session', () => {
  const invalidSession = { taskId: null, duration: 1500000, type: 'work', date: new Date() };
  assert.equal(validateSession(invalidSession), false);
});

test('validateTask returns true for valid task', () => {
  const task = { name: 'Test Task' };
  assert.equal(validateTask(task), true);
});

test('validateTask returns false for invalid task', () => {
  const invalidTask = { name: null };
  assert.equal(validateTask(invalidTask), false);
});

test('getNotificationSettings returns defaults', () => {
  const settings = getNotificationSettings({});
  assert.equal(settings.soundEnabled, true);
  assert.equal(settings.vibrationEnabled, true);
  assert.equal(settings.visualEnabled, true);
});

test('getNotificationSettings respects provided settings', () => {
  const settings = getNotificationSettings({ soundEnabled: false, vibrationEnabled: false });
  assert.equal(settings.soundEnabled, false);
  assert.equal(settings.vibrationEnabled, false);
  assert.equal(settings.visualEnabled, true);
});
