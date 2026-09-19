import { useState, useMemo } from 'react';
import Lobby from './Lobby';
import Auth from './Auth';
import './App.css';

function App() {
  // Stav přihlášeného hráče (pokud je null, ukáže se přihlašovací formulář)
  const [user, setUser] = useState(null);

  // Kontrola konfigurace Supabase v proměnných prostředí
  const supabaseStatus = useMemo(() => {
    const url = import.meta.env.VITE_SUPABASE_URL;
    const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
    const isConfigured = url && key && !url.includes('your-project') && !url.includes('placeholder');
    return isConfigured ? 'configured' : 'missing_env';
  }, []);

  // Callback po úspěšném přihlášení nebo vstupu hosta
  const handleLogin = (userData) => {
    setUser(userData);
  };

  // Odhlášení hráče
  const handleLogout = () => {
    setUser(null);
  };

  return (
    <div className="app-container">
      <div 
        className="status-bar" 
        style={{ 
          padding: '12px 20px', 
          textAlign: 'right',
          fontSize: '13px',
          background: 'rgba(10, 5, 20, 0.6)',
          borderBottom: '1px solid rgba(90, 62, 133, 0.3)',
          color: '#e0d6ff'
        }}
      >
        Supabase BaaS:{' '}
        {supabaseStatus === 'configured' ? (
          <strong style={{ color: '#4ade80' }}>🟢 Připraveno</strong>
        ) : (
          <span style={{ color: '#facc15' }} title="Doplňte VITE_SUPABASE_URL a VITE_SUPABASE_ANON_KEY do .env souboru">
            🟡 Čeká na .env klíče
          </span>
        )}
      </div>
      
      {!user ? (
        <Auth onLogin={handleLogin} />
      ) : (
        <Lobby user={user} onLogout={handleLogout} />
      )}
    </div>
  );
}

export default App;