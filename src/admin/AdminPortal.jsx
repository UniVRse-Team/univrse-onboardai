import React from 'react';
import { parseAdminPath, adminHome } from '../access/account-routing.mjs';
import { AccessBrand } from '../access/LoginPage';
import AdminDashboard from './AdminDashboard';
import AdminCompanyDetail from './AdminCompanyDetail';
import './admin.css';

export default function AdminPortal({ account, path, navigate, onSignOut }) {
  const parsed = parseAdminPath(path);

  return (
    <div className="admin-page">
      <header className="admin-header">
        <div className="admin-header-brand">
          <a
            href={adminHome}
            onClick={(e) => {
              e.preventDefault();
              navigate(adminHome);
            }}
          >
            <AccessBrand />
          </a>
          <span className="admin-role-badge">PLATFORM ADMIN</span>
        </div>
        <div className="admin-session">
          <span>
            Signed in as <strong>{account?.username || 'admin'}</strong>
          </span>
          <button type="button" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </header>

      <main className="admin-main">
        {parsed?.page === 'company' ? (
          <AdminCompanyDetail companyId={parsed.companyId} navigate={navigate} />
        ) : (
          <AdminDashboard navigate={navigate} />
        )}
      </main>
    </div>
  );
}
