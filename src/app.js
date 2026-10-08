import {
  createSession,
  createTask,
  updateTask,
  calculateDailyStats,
  calculateWeeklyStats,
  calculateStreak,
  getSessionsForDate,
  getSessionsForTask,
  formatDuration,
  validateSession,
  validateTask,
  getNotificationSettings
} from './logic.js';

const state = {
  sessions: [],
  tasks: [],
  currentTaskId: null,
  timer: null,
  timerRunning: false,
  timerDuration: 25 * 60 * 1000,
  timerRemaining: 25 * 60 * 1000,
  timerType: 'work'
};

// DOM Elements
const timerDisplay = document.getElementById('timerDisplay');
const startStopButton = document.getElementById('startStopButton');
const resetButton = document.getElementById('resetButton');
const taskSelect = document.getElementById('taskSelect');
const taskForm = document.getElementById('taskForm');
const taskName = document.getElementById('taskName');
const taskList = document.getElementById('taskList');
const dailyDuration = document.getElementById('dailyDuration');
const sessionCount = document.getElementById('sessionCount');
const streakCount = document.getElementById('streakCount');

// Initialize the app
function init() {
  loadState();
  renderTasks();
  renderStats();
  updateTimerDisplay();
  
  // Set up event listeners
  startStopButton.addEventListener('click', toggleTimer);
  resetButton.addEventListener('click', resetTimer);
  taskForm.addEventListener('submit', createNewTask);
  taskList.addEventListener('click', handleTaskListClick);
  taskSelect.addEventListener('change', (e) => {
    state.currentTaskId = e.target.value;
  });
}

// Load state from localStorage
function loadState() {
  try {
    const saved = localStorage.getItem('pomodoro-odak:v1');
    if (saved) {
      const data = JSON.parse(saved);
      state.sessions = data.sessions || [];
      state.tasks = data.tasks || [];
    }
  } catch (e) {
    console.error('Failed to load state:', e);
  }
}

// Save state to localStorage
function saveState() {
  try {
    localStorage.setItem('pomodoro-odak:v1', JSON.stringify({
      sessions: state.sessions,
      tasks: state.tasks
    }));
  } catch (e) {
    console.error('Failed to save state:', e);
  }
}

// Render tasks to the select and list
function renderTasks() {
  // Clear existing options
  taskSelect.innerHTML = '<option value="">Görev Seçin</option>';
  
  // Add tasks to select
  state.tasks.forEach(task => {
    const option = document.createElement('option');
    option.value = task.id;
    option.textContent = task.name;
    taskSelect.appendChild(option);
  });
  
  // Render task list
  taskList.innerHTML = '';
  state.tasks.forEach(task => {
    const li = document.createElement('li');
    li.className = 'task-item';
    li.innerHTML = `
      <span class="${task.completed ? 'completed' : ''}">${task.name}</span>
      <div class="task-actions">
        <button class="btn btn-small btn-secondary" data-action="toggle" data-id="${task.id}">${task.completed ? 'İptal' : 'Tamamla'}</button>
        <button class="btn btn-small btn-danger" data-action="delete" data-id="${task.id}">Sil</button>
      </div>
    `;
    taskList.appendChild(li);
  });
}

// Render statistics
function renderStats() {
  const today = new Date().toISOString().split('T')[0];
  const todaySessions = getSessionsForDate(state.sessions, today);
  
  if (todaySessions.length > 0) {
    const dailyStats = calculateDailyStats(todaySessions, today);
    dailyDuration.textContent = formatDuration(dailyStats.totalDuration);
    sessionCount.textContent = dailyStats.sessionCount;
  } else {
    dailyDuration.textContent = '0 dk';
    sessionCount.textContent = '0';
  }
  
  const streak = calculateStreak(state.sessions);
  streakCount.textContent = `${streak} gün`;
}

// Update timer display
function updateTimerDisplay() {
  const minutes = Math.floor(state.timerRemaining / 60000);
  const seconds = Math.floor((state.timerRemaining % 60000) / 1000);
  timerDisplay.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

// Toggle timer start/stop
function toggleTimer() {
  if (state.timerRunning) {
    stopTimer();
  } else {
    startTimer();
  }
}

// Start the timer
function startTimer() {
  if (!state.currentTaskId) {
    alert('Lütfen bir görev seçin');
    return;
  }
  
  state.timerRunning = true;
  startStopButton.textContent = 'Durdur';
  
  state.timer = setInterval(() => {
    state.timerRemaining -= 1000;
    updateTimerDisplay();
    
    if (state.timerRemaining <= 0) {
      stopTimer();
      completeSession();
    }
  }, 1000);
}

// Stop the timer
function stopTimer() {
  state.timerRunning = false;
  clearInterval(state.timer);
  startStopButton.textContent = 'Başlat';
}

// Reset the timer
function resetTimer() {
  stopTimer();
  state.timerRemaining = state.timerDuration;
  updateTimerDisplay();
}

// Complete a session
function completeSession() {
  const session = createSession({
    taskId: state.currentTaskId,
    duration: state.timerDuration,
    type: state.timerType,
    date: new Date().toISOString().split('T')[0]
  });
  
  if (validateSession(session)) {
    state.sessions.push(session);
    saveState();
    renderStats();
    
    // Play notification sound
    const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFfHl7fH6BhIeJiouMjY6QkZKTlJWXmJqcnZ6foKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr/AwcLDxMXGx8jJysvMzc7P0NHS09TV1tfY2drb3N3e3+Dh4uPk5ebn6Onq6+zt7u/w8fLz9PX29/j5+vv8/f7/AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fYGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn+AgYKDhIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ2en6ChoqOkpaanqKmqq6ytrq+wsbKztLW2t7i5uru8vb6/wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t/g4eLj5OXm5+jp6uvs7e7v8PHy8/T19vf4+fr7/P3+/wABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj9AQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVpbXF1eX2BhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ent8fX5/gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp+goaKjpKWmp6ipqqusra6vsLGys7S1tre4ubq7vL2+v8DBwsPExcbHyMnKy8zNzs/Q0dLT1NXW19jZ2tvc3d7f4OHi4+Tl5ufo6err7O3u7/Dx8vP09fb3+Pn6+/z9/v8=');
    audio.play().catch(e => console.log('Audio play failed:', e));
    
    // Switch to break mode
    state.timerType = state.timerType === 'work' ? 'break' : 'work';
    state.timerDuration = state.timerType === 'work' ? 25 * 60 * 1000 : 5 * 60 * 1000;
    state.timerRemaining = state.timerDuration;
    updateTimerDisplay();
  }
}

// Create a new task
function createNewTask(e) {
  e.preventDefault();
  
  const name = taskName.value.trim();
  if (!name) {
    alert('Görev adı boş olamaz');
    return;
  }
  
  const task = createTask({ name, completed: false });
  if (validateTask(task)) {
    state.tasks.push(task);
    saveState();
    renderTasks();
    taskName.value = '';
  } else {
    alert('Geçersiz görev adı');
  }
}

// Handle task list clicks
function handleTaskListClick(e) {
  const action = e.target.dataset.action;
  const taskId = e.target.dataset.id;
  
  if (action === 'toggle') {
    const task = state.tasks.find(t => t.id === taskId);
    if (task) {
      updateTask(taskId, { completed: !task.completed });
      saveState();
      renderTasks();
    }
  } else if (action === 'delete') {
    if (confirm('Bu görevi silmek istediğinize emin misiniz?')) {
      state.tasks = state.tasks.filter(t => t.id !== taskId);
      saveState();
      renderTasks();
    }
  }
}

// Initialize the app when DOM is loaded
document.addEventListener('DOMContentLoaded', init);
