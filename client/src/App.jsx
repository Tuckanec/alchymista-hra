import { useState, useCallback, useRef } from 'react';
import Lobby from './Lobby';
import Auth from './Auth';
import Toast from './Toast';
import './App.css';

function App() {
  const [user, setUser] = useState(null);
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
  };

  const handleLogout = () => {
    setUser(null);
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