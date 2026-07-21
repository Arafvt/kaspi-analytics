import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout/Layout';
import { DashboardPage } from './pages/DashboardPage/DashboardPage';
import { UnitPage } from './pages/UnitPage/UnitPage';
import { PlanPage } from './pages/PlanPage/PlanPage';
import { AnalyticsPage } from './pages/AnalyticsPage/AnalyticsPage';
import { CostsPage } from './pages/CostsPage/CostsPage';

export function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/unit" element={<UnitPage />} />
        <Route path="/plan" element={<PlanPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/costs" element={<CostsPage />} />
      </Routes>
    </Layout>
  );
}
