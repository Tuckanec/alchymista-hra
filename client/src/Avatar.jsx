import React from 'react';
import './Avatar.css';

export default function Avatar({ avatarUrl, name, size = 36, className = '', onClick, style = {} }) {
    const initial = (name && typeof name === 'string' && name.trim().length > 0)
        ? name.trim()[0].toUpperCase()
        : '🧙';

    return (
        <div
            className={`avatar-circle ${className} ${onClick ? 'avatar-clickable' : ''}`}
            style={{
                width: `${size}px`,
                height: `${size}px`,
                minWidth: `${size}px`,
                minHeight: `${size}px`,
                fontSize: `${Math.max(12, Math.round(size * 0.44))}px`,
                ...style
            }}
            onClick={onClick}
        >
            {avatarUrl ? (
                <img
                    src={avatarUrl}
                    alt={name || 'Avatar'}
                    className="avatar-img"
                    onError={(e) => {
                        // V případě chyby načtení skryjeme img a zobrazí se iniciála
                        e.currentTarget.style.display = 'none';
                        const parent = e.currentTarget.parentElement;
                        if (parent) {
                            let span = parent.querySelector('.avatar-initial-fallback');
                            if (!span) {
                                span = document.createElement('span');
                                span.className = 'avatar-initial avatar-initial-fallback';
                                span.textContent = initial;
                                parent.appendChild(span);
                            }
                        }
                    }}
                />
            ) : (
                <span className="avatar-initial">{initial}</span>
            )}
        </div>
    );
}
