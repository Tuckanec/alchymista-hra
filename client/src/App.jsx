import { useState, useCallback, useRef } from 'react';
import Lobby from './Lobby';
import Auth from './Auth';
import Toast from './Toast';
import './App.css';

const STORAGE_KEY = 'alchymista_user';

function App() {
  // Inicializace stavu přímo z localStorage (okamžitá obnova bez probliku přihlášení)
  const [user, setUser] = useState(() => {
    try {
      const savedUser = localStorage.getItem(STORAGE_KEY);
      if (savedUser) {
        const parsed = JSON.parse(savedUser);
        if (parsed && parsed.id) {
          return parsed;
        }
      }
    } catch (err) {
      console.error('Chyba při obnově uživatele z localStorage:', err);
      localStorage.removeItem(STORAGE_KEY);
    }
    return null;
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
    setUser(userData);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(userData));
    } catch (err) {
      console.error('Chyba při ukládání do localStorage:', err);
    }
  };

  const handleLogout = () => {
    setUser(null);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (err) {
      console.error('Chyba při mazání localStorage:', err);
    }
    showToast('Byl jsi úspěšně odhlášen.', 'info');
  };

  return (
    <div className="app-container">
      <Toast toast={toast} onClose={handleCloseToast} />

      {!user ? (
        <Auth onLogin={handleLogin} showToast={showToast} />
      ) : (
        <Lobby user={user} onLogout={handleLogout} showToast={showToast} />
      )}
    </div>
  );
}

export default App;