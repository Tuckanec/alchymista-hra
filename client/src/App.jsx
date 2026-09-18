import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import Lobby from './Lobby';
import Auth from './Auth'; // TOTO je ten klíčový import, který ti chyběl
import './App.css';

// Používáme adresu produkčního serveru na Renderu
const socket = io('https://alchymista-hra.onrender.com');

function App() {
  const [isConnected, setIsConnected] = useState(socket.connected);

  // Stav, který drží informace o přihlášeném hráči (pokud je null, ukáže se formulář)
  const [user, setUser] = useState(null); 

  useEffect(() => {
    socket.on('connect', () => setIsConnected(true));
    socket.on('disconnect', () => setIsConnected(false));

    return () => {
      socket.off('connect');
      socket.off('disconnect');
    };
  }, []);

  // Tuto funkci předáme do Auth komponenty - zavolá se po úspěšném přihlášení
  const handleLogin = (userData) => {
    setUser(userData);
  };

  return (
    <div className="app-container">
      <div className="status-bar" style={{ padding: '10px', textAlign: 'right' }}>
        Server: <strong>{isConnected ? '🟢 Online' : '🔴 Offline'}</strong>
      </div>
      
      {!user ? (
    <Auth onLogin={handleLogin} />
  ) : (
    <Lobby socket={socket} user={user} />
  )}
    </div>
  );
}

export default App;