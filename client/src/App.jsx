import { NavLink, Outlet, Navigate, Routes, Route } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Materials from './pages/Materials';
import Suppliers from './pages/Suppliers';
import Quotes from './pages/Quotes';

function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-logo">⚡</span>
        <div className="brand-text">
          <h1>PTYP</h1>
          <p>Proje Yönetim Sistemi</p>
        </div>
      </div>
      <nav>
        <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
          <span className="nav-ico">📊</span> Genel Bakış
        </NavLink>

        <div className="nav-group">TEDARİK</div>
        <NavLink to="/malzemeler" className={({ isActive }) => (isActive ? 'active' : '')}>
          <span className="nav-ico">📦</span> Malzeme Listesi
        </NavLink>
        <NavLink to="/saticilar" className={({ isActive }) => (isActive ? 'active' : '')}>
          <span className="nav-ico">🏢</span> Satıcılar
        </NavLink>
        <NavLink to="/teklifler" className={({ isActive }) => (isActive ? 'active' : '')}>
          <span className="nav-ico">💰</span> Teklif &amp; Karşılaştırma
        </NavLink>

        <div className="nav-group">YAKINDA</div>
        <div className="nav-soon"><span className="nav-ico">🔧</span> İş Takibi</div>
        <div className="nav-soon"><span className="nav-ico">🧾</span> Muhasebe</div>
        <div className="nav-soon"><span className="nav-ico">📁</span> Dokümanlar</div>
      </nav>
      <div className="sidebar-foot">Elektrik Nakil Hattı &amp;<br />Trafo Merkezi Projesi</div>
    </aside>
  );
}

export default function App() {
  return (
    <div className="layout">
      <Sidebar />
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/malzemeler" element={<Materials />} />
          <Route path="/saticilar" element={<Suppliers />} />
          <Route path="/teklifler" element={<Quotes />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <Outlet />
    </div>
  );
}
