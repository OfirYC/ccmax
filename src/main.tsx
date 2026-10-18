import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { Toasts } from './components';
import '@fontsource-variable/dm-sans';
import '@fontsource-variable/space-grotesk';
import '@fontsource/dm-mono/latin-400.css';
import '@fontsource/dm-mono/latin-500.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><BrowserRouter><Toasts><App/></Toasts></BrowserRouter></React.StrictMode>);
