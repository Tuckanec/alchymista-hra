import { useState, useCallback, useRef } from 'react';
import Lobby from './Lobby';
import Toast from './Toast';
import './App.css';

const STORAGE_KEY = 'alchymista_user';

function App() {
  // Synchronní inicializace stavu přímo z localStorage
  const [user, setUser] = useState(() => {
    try {
      const savedUser = localStorage.getItem(STORAGE_KEY);
      if (!savedUser) return null;
      const parsed = JSON.parse(savedUser);
      // Ověříme, že uložený uživatel má platné ID
      if (parsed && parsed.id && !isNaN(Number(parsed.id))) {
        return parsed;
      }
      return null;
    } catch (err) {
      console.error('Chyba při čtení localStorage:', err);
      return null;
    }
  });

  const [toast, setToast] = useState(null);
  const toastTimerRef = useRef(null);

  // In-page Toast notifikace s automatickým skrytím po 3 vteřinách
  const showToast = useCallback((message, type = 'info') => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    setToast({ message, type });
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
    }, 3000);
  }, []);

  const handleCloseToast = useCallback(() => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
    }
    setToast(null);
  }, []);

  const handleLogin = (userData) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(userData));
    } catch (err) {
      console.error('Chyba při ukládání do localStorage:', err);
    }
    setUser(userData);
  };

  const handleLogout = () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      console.error('Chyba při mazání localStorage:', err);
    }
    setUser(null);
    showToast('Byl jsi úspěšně odhlášen.', 'info');
  };

  return (
    <div className="app-container">
      <Toast toast={toast} onClose={handleCloseToast} />
      <Lobby
        user={user}
        onLogin={handleLogin}
        onLogout={handleLogout}
        showToast={showToast}
      />
    </div>
  );
}

export default App;