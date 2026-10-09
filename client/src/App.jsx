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

function Sidebar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const isOwner = user.role === 'owner';

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
        {isOwner ? (
          <>
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

            <div className="nav-group">PROJE</div>
            <NavLink to="/is-takibi" className={({ isActive }) => (isActive ? 'active' : '')}>
              <span className="nav-ico">🔧</span> İş Takibi &amp; Güzergah
            </NavLink>
            <NavLink to="/hakedisler" className={({ isActive }) => (isActive ? 'active' : '')}>
              <span className="nav-ico">🧾</span> Hakediş Yönetimi
            </NavLink>
            <NavLink to="/gunluk-raporlar" className={({ isActive }) => (isActive ? 'active' : '')}>
              <span className="nav-ico">📝</span> Günlük Raporlar
            </NavLink>

            <div className="nav-group">YÖNETİM</div>
            <NavLink to="/kullanicilar" className={({ isActive }) => (isActive ? 'active' : '')}>
              <span className="nav-ico">👥</span> Kullanıcılar
            </NavLink>

            <div className="nav-group">YAKINDA</div>
            <div className="nav-soon"><span className="nav-ico">🧾</span> Muhasebe</div>
            <div className="nav-soon"><span className="nav-ico">📁</span> Dokümanlar</div>
          </>
        ) : (
          <>
            <div className="nav-group">TEDARİKÇİ PORTALI</div>
            <NavLink to="/malzemeler" className={({ isActive }) => (isActive ? 'active' : '')}>
              <span className="nav-ico">📦</span> Açık Malzemeler
            </NavLink>
            <NavLink to="/tekliflerim" className={({ isActive }) => (isActive ? 'active' : '')}>
              <span className="nav-ico">💰</span> Tekliflerim
            </NavLink>
          </>
        )}
      </nav>
      <div className="sidebar-foot">
        <div className="sidebar-user">
          <span className="user-ico">{isOwner ? '👷' : '🏢'}</span>
          <div>
            <div className="user-name">{user.display_name || user.username}</div>
            <div className="user-role">{isOwner ? 'İş Sahibi' : 'Satıcı'}</div>
          </div>
        </div>
        <button
          className="logout-btn"
          onClick={() => {
            logout();
            navigate('/login');
          }}
        >
          Çıkış Yap ⏻
        </button>
      </div>
    </aside>
  );
}

function Shell() {
  const { user, ready } = useAuth();
  const location = useLocation();

  if (!ready) return <div className="loading-screen">⏳ Yükleniyor…</div>;

  const isLogin = location.pathname === '/login';
  const isPublic = location.pathname === '/teklif-yukle';
  if (!user && !isLogin && !isPublic) return <Navigate to="/login" replace />;
  if (user && (isLogin || isPublic)) return <Navigate to={user.role === 'owner' ? '/' : '/malzemeler'} replace />;

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
              <Route path="/hakedisler" element={<ProgressPayments />} />
              <Route path="/gunluk-raporlar" element={<DailyReports />} />
              <Route path="/kullanicilar" element={<Users />} />
              <Route path="*" element={<Navigate to="/" replace />} />
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
