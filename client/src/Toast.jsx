import './Toast.css';

export default function Toast({ toast, onClose }) {
    if (!toast) return null;

    return (
        <div className="toast-container">
            <div className={`toast toast-${toast.type || 'info'}`} role="alert">
                <span className="toast-icon">
                    {toast.type === 'success' && '✓'}
                    {toast.type === 'error' && '✕'}
                    {toast.type === 'info' && 'ℹ'}
                </span>
                <span className="toast-message">{toast.message}</span>
                <button 
                    type="button" 
                    className="toast-close" 
                    onClick={onClose} 
                    aria-label="Zavřít"
                >
                    &times;
                </button>
            </div>
        </div>
    );
}
