import { Navigate, Route, Routes } from 'react-router-dom'
import { CreateMode } from '@/pages/CreateMode'
import { LearnMode } from '@/pages/LearnMode'
import { ManageMode } from '@/pages/ManageMode'
import { ModeSelector } from '@/pages/ModeSelector'
import { Settings } from '@/pages/Settings'

function App() {
  return (
    <Routes>
      <Route path="/" element={<ModeSelector />} />
      <Route path="/create" element={<CreateMode />} />
      <Route path="/learn" element={<LearnMode />} />
      <Route path="/manage" element={<ManageMode />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
