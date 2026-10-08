const createSession = ({ taskId, duration, type, date }) => {
  if (!taskId || typeof taskId !== 'string') throw new Error('Invalid taskId');
  if (typeof duration !== 'number' || duration <= 0) throw new Error('Invalid duration');
  if (!type || !['work', 'break'].includes(type)) throw new Error('Invalid type');
  if (!date || !(date instanceof Date)) throw new Error('Invalid date');
  return { taskId, duration, type, date };
};

const createTask = ({ name, completed = false }) => {
  if (!name || typeof name !== 'string') throw new Error('Invalid task name');
  return { id: Math.random().toString(36).substr(2, 9), name, completed };
};

const updateTask = (taskId, updates) => {
  if (!taskId || typeof taskId !== 'string') throw new Error('Invalid taskId');
  if (typeof updates !== 'object' || updates === null) throw new Error('Invalid updates');
  return { ...updates };
};

const calculateDailyStats = (sessions, date) => {
  if (!Array.isArray(sessions)) throw new Error('Invalid sessions');
  if (!date || !(date instanceof Date)) throw new Error('Invalid date');
  const sessionsForDate = sessions.filter(s => s.date.toDateString() === date.toDateString());
  const workSessions = sessionsForDate.filter(s => s.type === 'work');
  const totalWorkDuration = workSessions.reduce((sum, s) => sum + s.duration, 0);
  const totalSessions = sessionsForDate.length;
  const workSessionsCount = workSessions.length;
  return { totalWorkDuration, totalSessions, workSessionsCount };
};

const calculateWeeklyStats = (sessions, startDate) => {
  if (!Array.isArray(sessions)) throw new Error('Invalid sessions');
  if (!startDate || !(startDate instanceof Date)) throw new Error('Invalid start date');
  const endDate = new Date(startDate);
  endDate.setDate(startDate.getDate() + 6);
  const filteredSessions = sessions.filter(s => s.date >= startDate && s.date <= endDate);
  const dailyStats = {};
  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toDateString();
    dailyStats[dateStr] = calculateDailyStats(filteredSessions, d);
  }
  const totalWorkDuration = filteredSessions.filter(s => s.type === 'work').reduce((sum, s) => sum + s.duration, 0);
  const totalSessions = filteredSessions.length;
  const workSessionsCount = filteredSessions.filter(s => s.type === 'work').length;
  return { dailyStats, totalWorkDuration, totalSessions, workSessionsCount };
};

const calculateStreak = (sessions) => {
  if (!Array.isArray(sessions)) throw new Error('Invalid sessions');
  if (sessions.length === 0) return 0;
  const sorted = [...sessions].sort((a, b) => a.date - b.date);
  let maxStreak = 0;
  let currentStreak = 0;
  let lastDate = null;
  for (const session of sorted) {
    const date = session.date.toDateString();
    if (!lastDate) {
      currentStreak = 1;
    } else {
      const last = new Date(lastDate);
      const current = new Date(date);
      const diffDays = (current - last) / (1000 * 60 * 60 * 24);
      if (diffDays === 1) {
        currentStreak++;
      } else {
        maxStreak = Math.max(maxStreak, currentStreak);
        currentStreak = 1;
      }
    }
    lastDate = date;
  }
  return Math.max(maxStreak, currentStreak);
};

const getSessionsForDate = (sessions, date) => {
  if (!Array.isArray(sessions)) throw new Error('Invalid sessions');
  if (!date || !(date instanceof Date)) throw new Error('Invalid date');
  return sessions.filter(s => s.date.toDateString() === date.toDateString());
};

const getSessionsForTask = (sessions, taskId) => {
  if (!Array.isArray(sessions)) throw new Error('Invalid sessions');
  if (!taskId || typeof taskId !== 'string') throw new Error('Invalid taskId');
  return sessions.filter(s => s.taskId === taskId);
};

const formatDuration = (milliseconds) => {
  if (typeof milliseconds !== 'number' || milliseconds < 0) throw new Error('Invalid milliseconds');
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
};

const validateSession = (session) => {
  try {
    createSession(session);
    return true;
  } catch {
    return false;
  }
};

const validateTask = (task) => {
  try {
    createTask(task);
    return true;
  } catch {
    return false;
  }
};

const getNotificationSettings = (settings) => {
  if (typeof settings !== 'object' || settings === null) throw new Error('Invalid settings');
  return {
    soundEnabled: settings.soundEnabled ?? true,
    vibrationEnabled: settings.vibrationEnabled ?? true,
    visualEnabled: settings.visualEnabled ?? true
  };
};

export { createSession, createTask, updateTask, calculateDailyStats, calculateWeeklyStats, calculateStreak, getSessionsForDate, getSessionsForTask, formatDuration, validateSession, validateTask, getNotificationSettings };
