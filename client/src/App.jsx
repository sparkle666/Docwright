import React from 'react';
import { HashRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import DashboardPage from './pages/DashboardPage.jsx';
import NewProjectPage from './pages/NewProjectPage.jsx';
import ProjectPage from './pages/ProjectPage.jsx';
import AssetsPage from './pages/AssetsPage.jsx';
import TranscriptPage from './pages/TranscriptPage.jsx';
import VoiceOverPage from './pages/VoiceOverPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import './App.css';

function Header() {
  const location = useLocation();
  const isHome = location.pathname === '/';
  return (
    <header className="app-header">
      <Link to="/" className="brand">
        <span className="brand-mark">DW</span>
        <span className="brand-name">Docwright</span>
      </Link>
      <div className="header-actions">
        <Link to="/settings" className="btn btn-ghost btn-sm">Settings</Link>
        {isHome && (
          <>
            <Link to="/new?mode=video" className="btn btn-secondary">
              + New AI video
            </Link>
            <Link to="/new" className="btn btn-primary">
              + New documentation
            </Link>
          </>
        )}
      </div>
    </header>
  );
}

export default function App() {
  return (
    <HashRouter>
      <div className="app-shell">
        <Header />
        <main className="app-main">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/new" element={<NewProjectPage />} />
            <Route path="/projects/:id" element={<ProjectPage />} />
            <Route path="/projects/:id/assets" element={<AssetsPage />} />
            <Route path="/projects/:id/transcript" element={<TranscriptPage />} />
            <Route path="/projects/:id/voice" element={<VoiceOverPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}