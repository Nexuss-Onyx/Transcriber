import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { getApiKey, setApiKey } from './utils/geminiDirect';

if (!getApiKey()) {
  const k = window.prompt("Enter your Gemini API key to enable transcription:");
  if (k) setApiKey(k);
}

createRoot(document.getElementById('root')!).render(<App />);
