import { useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext';
import Dashboard from './pages/Dashboard';
import Materials from './pages/Materials';
import Suppliers from './pages/Suppliers';
import Quotes from './pages/Quotes';
import Users from './pages/Users';
import WorkTracking from './pages/WorkTracking';
import Login from './pages/Login';
import SupplierMaterials from './pages/SupplierMaterials';
import SupplierQuotes from './pages/SupplierQuotes';
import QuoteUpload from './pages/QuoteUpload';
import ProgressPayments from './pages/ProgressPayments';
import DailyReports from './pages/DailyReports';
import DocumentKmz from './pages/DocumentKmz';
import Kesif from './pages/Kesif';
import Saha from './pages/Saha';
import Kamulastirma from './pages/Kamulastirma';
import Depo from './pages/Depo';
import Planlama from './pages/Planlama';
import FiyatFarki from './pages/FiyatFarki';

function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('ptyp_theme') || 'light';
    } catch {
      return 'light';
    }
  });
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('ptyp_theme', theme);
    } catch {
      /* yok say */
    }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}

function Sidebar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const isOwner = user.role === 'owner';
  const isField = user.role === 'field';
  const [theme, toggleTheme] = useTheme();

  return (
    <aside className="sidebar">
      <div className="brand">
        
        <div className="brand-text">
          <h1>PTYP</h1>
          <p>Proje Yönetim Sistemi</p>
        </div>
      </div>
      <nav>
        {isOwner ? (
          <>
            <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
              Genel Bakış
            </NavLink>

            <div className="nav-group">TEDARİK</div>
            <NavLink to="/malzemeler" className={({ isActive }) => (isActive ? 'active' : '')}>
              Malzeme Listesi
            </NavLink>
            <NavLink to="/depo" className={({ isActive }) => (isActive ? 'active' : '')}>
              Depo &amp; Stok
            </NavLink>
            <NavLink to="/saticilar" className={({ isActive }) => (isActive ? 'active' : '')}>
              Satıcılar
            </NavLink>
            <NavLink to="/teklifler" className={({ isActive }) => (isActive ? 'active' : '')}>
              Teklif &amp; Karşılaştırma
            </NavLink>

            <div className="nav-group">PROJE</div>
            <NavLink to="/is-takibi" className={({ isActive }) => (isActive ? 'active' : '')}>
              İş Takibi &amp; Güzergah
            </NavLink>
            <NavLink to="/kamulastirma" className={({ isActive }) => (isActive ? 'active' : '')}>
              Kamulaştırma
            </NavLink>
            <NavLink to="/planlama" className={({ isActive }) => (isActive ? 'active' : '')}>
              Plan &amp; Gerçekleşme
            </NavLink>
            <NavLink to="/hakedisler" className={({ isActive }) => (isActive ? 'active' : '')}>
              Hakediş Yönetimi
            </NavLink>
            <NavLink to="/fiyat-farki" className={({ isActive }) => (isActive ? 'active' : '')}>
              Fiyat Farkı
            </NavLink>
            <NavLink to="/kesif" className={({ isActive }) => (isActive ? 'active' : '')}>
              Keşif
            </NavLink>
            <NavLink to="/saha" className={({ isActive }) => (isActive ? 'active' : '')}>
              Saha
            </NavLink>
            <NavLink to="/gunluk-raporlar" className={({ isActive }) => (isActive ? 'active' : '')}>
              Günlük Raporlar
            </NavLink>
            <NavLink to="/belge-kmz" className={({ isActive }) => (isActive ? 'active' : '')}>
              Belge → KMZ
            </NavLink>

            <div className="nav-group">YÖNETİM</div>
            <NavLink to="/kullanicilar" className={({ isActive }) => (isActive ? 'active' : '')}>
              Kullanıcılar
            </NavLink>

            <div className="nav-group">YAKINDA</div>
            <div className="nav-soon">Dokümanlar</div>
          </>
        ) : isField ? (
          <>
            <div className="nav-group">SAHA</div>
            <NavLink to="/saha" className={({ isActive }) => (isActive ? 'active' : '')}>
              Saha
            </NavLink>
          </>
        ) : (
          <>
            <div className="nav-group">TEDARİKÇİ PORTALI</div>
            <NavLink to="/malzemeler" className={({ isActive }) => (isActive ? 'active' : '')}>
              Açık Malzemeler
            </NavLink>
            <NavLink to="/tekliflerim" className={({ isActive }) => (isActive ? 'active' : '')}>
              Tekliflerim
            </NavLink>
          </>
        )}
      </nav>
      <div className="sidebar-foot">
        <div className="sidebar-user">
          <span className="user-ico">{isOwner ? '' : ''}</span>
          <div>
            <div className="user-name">{user.display_name || user.username}</div>
            <div className="user-role">{isOwner ? 'İş Sahibi' : isField ? 'Saha Ekibi' : 'Satıcı'}</div>
          </div>
        </div>
        <button className="theme-toggle" onClick={toggleTheme}>
          {theme === 'dark' ? 'Aydınlık Tema' : 'Karanlık Tema'}
        </button>
        <button
          className="logout-btn"
          onClick={() => {
            logout();
            navigate('/login');
          }}
        >
          Çıkış Yap
        </button>
      </div>
    </aside>
  );
}

function Shell() {
  const { user, ready } = useAuth();
  const location = useLocation();

  if (!ready) return <div className="loading-screen">Yükleniyor…</div>;

  const isLogin = location.pathname === '/login';
  const isPublic = location.pathname === '/teklif-yukle';
  const loc = location.pathname + location.search;
  if (!user && !isLogin && !isPublic) {
    try {
      if (loc !== '/login') sessionStorage.setItem('ptyp_after_login', loc);
    } catch {
      /* yok say */
    }
    return <Navigate to="/login" replace />;
  }
  if (user && (isLogin || isPublic)) {
    let after = null;
    try {
      after = sessionStorage.getItem('ptyp_after_login');
      sessionStorage.removeItem('ptyp_after_login');
    } catch {
      /* yok say */
    }
    const target =
      after && after !== '/login'
        ? after
        : user.role === 'owner'
          ? '/'
          : user.role === 'field'
            ? '/saha'
            : '/malzemeler';
    return <Navigate to={target} replace />;
  }

  return (
    <div className={isLogin || isPublic ? 'layout-login' : 'layout'}>
      {!isLogin && !isPublic && <Sidebar />}
      <main className={isLogin || isPublic ? 'main-login' : 'main'}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/teklif-yukle" element={<QuoteUpload />} />
          {user && user.role === 'owner' ? (
            <>
              <Route path="/" element={<Dashboard />} />
              <Route path="/malzemeler" element={<Materials />} />
              <Route path="/saticilar" element={<Suppliers />} />
              <Route path="/teklifler" element={<Quotes />} />
              <Route path="/is-takibi" element={<WorkTracking />} />
              <Route path="/guzergah" element={<Navigate to="/is-takibi" replace />} />
              <Route path="/kamulastirma" element={<Kamulastirma />} />
              <Route path="/planlama" element={<Planlama />} />
              <Route path="/depo" element={<Depo />} />
              <Route path="/hakedisler" element={<ProgressPayments />} />
              <Route path="/fiyat-farki" element={<FiyatFarki />} />
              <Route path="/kesif" element={<Kesif />} />
              <Route path="/saha" element={<Saha />} />
              <Route path="/saha/direk/:proje/:direk" element={<Saha />} />
              <Route path="/gunluk-raporlar" element={<DailyReports />} />
              <Route path="/belge-kmz" element={<DocumentKmz />} />
              <Route path="/kullanicilar" element={<Users />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </>
          ) : user && user.role === 'field' ? (
            <>
              <Route path="/saha" element={<Saha />} />
              <Route path="/saha/direk/:proje/:direk" element={<Saha />} />
              <Route path="*" element={<Navigate to="/saha" replace />} />
            </>
          ) : (
            <>
              <Route path="/" element={<Navigate to="/malzemeler" replace />} />
              <Route path="/malzemeler" element={<SupplierMaterials />} />
              <Route path="/tekliflerim" element={<SupplierQuotes />} />
              <Route path="*" element={<Navigate to="/malzemeler" replace />} />
            </>
          )}
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
