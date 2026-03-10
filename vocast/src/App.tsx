import { Routes, Route } from 'react-router-dom'
import Landing from '@/pages/Landing'
import Login from '@/pages/auth/Login'
import Signup from '@/pages/auth/Signup'
import Onboarding from '@/pages/Onboarding'
import DashboardLayout from '@/components/layout/DashboardLayout'
import DashboardHome from '@/pages/dashboard/DashboardHome'
import Videos from '@/pages/dashboard/Videos'
import Scripts from '@/pages/dashboard/Scripts'
import Analytics from '@/pages/dashboard/Analytics'
import ConnectedAccounts from '@/pages/dashboard/ConnectedAccounts'
import Settings from '@/pages/dashboard/Settings'

export default function App() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/onboarding" element={<Onboarding />} />

      {/* Dashboard */}
      <Route path="/dashboard" element={<DashboardLayout />}>
        <Route index element={<DashboardHome />} />
        <Route path="videos" element={<Videos />} />
        <Route path="scripts" element={<Scripts />} />
        <Route path="analytics" element={<Analytics />} />
        <Route path="connected-accounts" element={<ConnectedAccounts />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  )
}
