import { useEffect, useState } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  Briefcase,
  Building2,
  Calculator,
  ClipboardList,
  Compass,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  HardHat,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Map,
  MapPin,
  Menu,
  Moon,
  Package,
  Receipt,
  Scale,
  Sun,
  TrendingUp,
  Users as UsersIcon,
  Warehouse,
  X,
} from 'lucide-react';
import { AuthProvider, useAuth } from './AuthContext';
import { api } from './api';
import Modal from './components/Modal';
import Dashboard from './pages/Dashboard';
import Portfolyo from './pages/Portfolyo';
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
import Isg from './pages/Isg';
import Dokumanlar from './pages/Dokumanlar';

export function PtypMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3L6.5 21M12 3L17.5 21M5 9.5H19M7 14.5H17" />
      </svg>
    </span>
  );
}

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

function Sidebar({ menuOpen, setMenuOpen }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const isOwner = user.role === 'owner';
  const isField = user.role === 'field';
  const [theme, toggleTheme] = useTheme();
  const [pwOpen, setPwOpen] = useState(false);
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [pwMsg, setPwMsg] = useState(null);
  const [pwBusy, setPwBusy] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname, setMenuOpen]);

  async function submitPw(e) {
    e.preventDefault();
    setPwBusy(true);
    setPwMsg(null);
    try {
      await api.post('/api/auth/change-password', { old_password: oldPw, new_password: newPw });
      setPwOpen(false);
      setOldPw('');
      setNewPw('');
    } catch (err) {
      setPwMsg(err.message);
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <>
      <header className="mobile-topbar">
        <button
          type="button"
          className="mobile-menu-btn"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Menüyü aç veya kapat"
        >
          {menuOpen ? <X size={18} strokeWidth={1.5} /> : <Menu size={18} strokeWidth={1.5} />}
        </button>
        <div className="mobile-topbar-brand">
          <strong>PTYP</strong>
          <span>{isOwner ? 'İş sahibi' : isField ? 'Saha ekibi' : 'Tedarikçi'}</span>
        </div>
        <div className="mobile-topbar-actions">
          <button
            type="button"
            className="mobile-icon-btn"
            onClick={toggleTheme}
            title={theme === 'dark' ? 'Aydınlık tema' : 'Karanlık tema'}
          >
            {theme === 'dark' ? 'Açık' : 'Koyu'}
          </button>
          <button
            type="button"
            className="mobile-icon-btn"
            onClick={() => {
              logout();
              navigate('/login');
            }}
          >
            Çıkış
          </button>
        </div>
      </header>

      {menuOpen && <div className="sidebar-backdrop" onClick={() => setMenuOpen(false)} />}

      <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
        <div className="brand">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <PtypMark />
            <div className="brand-text">
              <h1>PTYP</h1>
              <p>ENH ve trafo yönetimi</p>
            </div>
          </div>
          <button
            type="button"
            className="sidebar-close-btn"
            onClick={() => setMenuOpen(false)}
            aria-label="Menüyü kapat"
          >
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
        <nav>
          {isOwner ? (
            <>
              <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
                <LayoutDashboard size={16} strokeWidth={1.5} />
                <span>Genel bakış</span>
              </NavLink>
              <NavLink to="/portfoy" className={({ isActive }) => (isActive ? 'active' : '')}>
                <Briefcase size={16} strokeWidth={1.5} />
                <span>Portföy</span>
              </NavLink>

              <div className="nav-group">Saha ve ilerleme</div>
              <NavLink to="/saha" className={({ isActive }) => (isActive ? 'active' : '')}>
                <MapPin size={16} strokeWidth={1.5} />
                <span>Saha</span>
              </NavLink>
              <NavLink to="/is-takibi" className={({ isActive }) => (isActive ? 'active' : '')}>
                <Activity size={16} strokeWidth={1.5} />
                <span>İş takibi ve güzergah</span>
              </NavLink>
              <NavLink to="/planlama" className={({ isActive }) => (isActive ? 'active' : '')}>
                <TrendingUp size={16} strokeWidth={1.5} />
                <span>Plan ve gerçekleşme</span>
              </NavLink>
              <NavLink to="/gunluk-raporlar" className={({ isActive }) => (isActive ? 'active' : '')}>
                <ClipboardList size={16} strokeWidth={1.5} />
                <span>Günlük raporlar</span>
              </NavLink>
              <NavLink to="/isg" className={({ isActive }) => (isActive ? 'active' : '')}>
                <HardHat size={16} strokeWidth={1.5} />
                <span>İSG</span>
              </NavLink>

              <div className="nav-group">Maliyet ve hakediş</div>
              <NavLink to="/kesif" className={({ isActive }) => (isActive ? 'active' : '')}>
                <Calculator size={16} strokeWidth={1.5} />
                <span>Keşif</span>
              </NavLink>
              <NavLink to="/hakedisler" className={({ isActive }) => (isActive ? 'active' : '')}>
                <Receipt size={16} strokeWidth={1.5} />
                <span>Hakediş yönetimi</span>
              </NavLink>
              <NavLink to="/fiyat-farki" className={({ isActive }) => (isActive ? 'active' : '')}>
                <Scale size={16} strokeWidth={1.5} />
                <span>Fiyat farkı</span>
              </NavLink>
              <NavLink to="/kamulastirma" className={({ isActive }) => (isActive ? 'active' : '')}>
                <Map size={16} strokeWidth={1.5} />
                <span>Kamulaştırma</span>
              </NavLink>

              <div className="nav-group">Tedarik</div>
              <NavLink to="/malzemeler" className={({ isActive }) => (isActive ? 'active' : '')}>
                <Package size={16} strokeWidth={1.5} />
                <span>Malzeme listesi</span>
              </NavLink>
              <NavLink to="/depo" className={({ isActive }) => (isActive ? 'active' : '')}>
                <Warehouse size={16} strokeWidth={1.5} />
                <span>Depo ve stok</span>
              </NavLink>
              <NavLink to="/saticilar" className={({ isActive }) => (isActive ? 'active' : '')}>
                <Building2 size={16} strokeWidth={1.5} />
                <span>Satıcılar</span>
              </NavLink>
              <NavLink to="/teklifler" className={({ isActive }) => (isActive ? 'active' : '')}>
                <FileSpreadsheet size={16} strokeWidth={1.5} />
                <span>Teklif karşılaştırma</span>
              </NavLink>

              <div className="nav-group">Yönetim</div>
              <NavLink to="/belge-kmz" className={({ isActive }) => (isActive ? 'active' : '')}>
                <Compass size={16} strokeWidth={1.5} />
                <span>Belge → KMZ</span>
              </NavLink>
              <NavLink to="/dokumanlar" className={({ isActive }) => (isActive ? 'active' : '')}>
                <FolderOpen size={16} strokeWidth={1.5} />
                <span>Dokümanlar</span>
              </NavLink>
              <NavLink to="/kullanicilar" className={({ isActive }) => (isActive ? 'active' : '')}>
                <UsersIcon size={16} strokeWidth={1.5} />
                <span>Kullanıcılar</span>
              </NavLink>
            </>
          ) : isField ? (
            <>
              <div className="nav-group">Saha operasyon</div>
              <NavLink to="/saha" className={({ isActive }) => (isActive ? 'active' : '')}>
                <MapPin size={16} strokeWidth={1.5} />
                <span>Saha ve direk takibi</span>
              </NavLink>
              <NavLink to="/gunluk-raporlar" className={({ isActive }) => (isActive ? 'active' : '')}>
                <ClipboardList size={16} strokeWidth={1.5} />
                <span>Günlük raporlar</span>
              </NavLink>
              <NavLink to="/isg" className={({ isActive }) => (isActive ? 'active' : '')}>
                <HardHat size={16} strokeWidth={1.5} />
                <span>İSG ve toolbox</span>
              </NavLink>
            </>
          ) : (
            <>
              <div className="nav-group">Tedarikçi portalı</div>
              <NavLink to="/malzemeler" className={({ isActive }) => (isActive ? 'active' : '')}>
                <Package size={16} strokeWidth={1.5} />
                <span>Açık malzemeler</span>
              </NavLink>
              <NavLink to="/tekliflerim" className={({ isActive }) => (isActive ? 'active' : '')}>
                <FileText size={16} strokeWidth={1.5} />
                <span>Tekliflerim</span>
              </NavLink>
            </>
          )}
        </nav>
        <div className="sidebar-foot">
          <div className="sidebar-user">
            <div>
              <div className="user-name">{user.display_name || user.username}</div>
              <div className="user-role">{isOwner ? 'İş sahibi' : isField ? 'Saha ekibi' : 'Satıcı'}</div>
            </div>
            <span className="status-dot ok" title="Oturum aktif" />
          </div>
          <div className="sidebar-foot-row">
            <button type="button" className="theme-toggle" onClick={toggleTheme}>
              {theme === 'dark' ? <Sun size={14} strokeWidth={1.5} /> : <Moon size={14} strokeWidth={1.5} />}
              <span>{theme === 'dark' ? 'Açık' : 'Koyu'}</span>
            </button>
            <button
              type="button"
              className="theme-toggle"
              onClick={() => {
                setOldPw('');
                setNewPw('');
                setPwMsg(null);
                setPwOpen(true);
              }}
            >
              <KeyRound size={14} strokeWidth={1.5} />
              <span>Şifre</span>
            </button>
          </div>
          <button
            type="button"
            className="logout-btn"
            onClick={() => {
              logout();
              navigate('/login');
            }}
          >
            <LogOut size={14} strokeWidth={1.5} />
            <span>Çıkış yap</span>
          </button>
        </div>
        {pwOpen && (
          <Modal title="Şifre değiştir" onClose={() => setPwOpen(false)}>
            <form onSubmit={submitPw}>
              {pwMsg && <div className="form-error">{pwMsg}</div>}
              <div className="field">
                <label>Mevcut şifre *</label>
                <input
                  type="password"
                  value={oldPw}
                  onChange={(e) => setOldPw(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <div className="field">
                <label>Yeni şifre (en az 6 karakter) *</label>
                <input
                  type="password"
                  minLength={6}
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  required
                />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn" onClick={() => setPwOpen(false)}>
                  Vazgeç
                </button>
                <button type="submit" className="btn btn-primary" disabled={pwBusy}>
                  {pwBusy ? 'Kaydediliyor…' : 'Güncelle'}
                </button>
              </div>
            </form>
          </Modal>
        )}
      </aside>
    </>
  );
}

function Shell() {
  const { user, ready } = useAuth();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

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
      {!isLogin && !isPublic && <Sidebar menuOpen={menuOpen} setMenuOpen={setMenuOpen} />}
      <main className={isLogin || isPublic ? 'main-login' : 'main'}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/teklif-yukle" element={<QuoteUpload />} />
          {user && user.role === 'owner' ? (
            <>
              <Route path="/" element={<Dashboard />} />
              <Route path="/portfoy" element={<Portfolyo />} />
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
              <Route path="/isg" element={<Isg />} />
              <Route path="/dokumanlar" element={<Dokumanlar />} />
              <Route path="/belge-kmz" element={<DocumentKmz />} />
              <Route path="/kullanicilar" element={<Users />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </>
          ) : user && user.role === 'field' ? (
            <>
              <Route path="/saha" element={<Saha />} />
              <Route path="/saha/direk/:proje/:direk" element={<Saha />} />
              <Route path="/gunluk-raporlar" element={<DailyReports />} />
              <Route path="/isg" element={<Isg />} />
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
      {!isLogin && !isPublic && user && (user.role === 'field' || user.role === 'owner') && (
        <nav className="mobile-bottom-nav" aria-label="Mobil hızlı menü">
          {user.role === 'owner' && (
            <NavLink to="/" end className={({ isActive }) => (isActive ? 'mb-item active' : 'mb-item')}>
              <LayoutDashboard size={18} strokeWidth={1.5} />
              <span>Özet</span>
            </NavLink>
          )}
          <NavLink to="/saha" className={({ isActive }) => (isActive ? 'mb-item active' : 'mb-item')}>
            <MapPin size={18} strokeWidth={1.5} />
            <span>Saha</span>
          </NavLink>
          <NavLink to="/gunluk-raporlar" className={({ isActive }) => (isActive ? 'mb-item active' : 'mb-item')}>
            <ClipboardList size={18} strokeWidth={1.5} />
            <span>Günlük</span>
          </NavLink>
          <NavLink to="/isg" className={({ isActive }) => (isActive ? 'mb-item active' : 'mb-item')}>
            <HardHat size={18} strokeWidth={1.5} />
            <span>İSG</span>
          </NavLink>
          {user.role === 'owner' && (
            <NavLink to="/hakedisler" className={({ isActive }) => (isActive ? 'mb-item active' : 'mb-item')}>
              <Receipt size={18} strokeWidth={1.5} />
              <span>Hakediş</span>
            </NavLink>
          )}
          <button
            type="button"
            className={`mb-item ${menuOpen ? 'active' : ''}`}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <Menu size={18} strokeWidth={1.5} />
            <span>Menü</span>
          </button>
        </nav>
      )}
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
