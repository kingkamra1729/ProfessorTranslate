import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './index.css';
import Home from './routes/Home';
import Professor from './routes/Professor';
import Student from './routes/Student';
import Replay from './routes/Replay';
import Check from './routes/Check';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/teach" element={<Professor />} />
        <Route path="/teach/:code" element={<Professor />} />
        <Route path="/listen" element={<Student />} />
        <Route path="/listen/:code" element={<Student />} />
        <Route path="/check" element={<Check />} />
        <Route path="/replay" element={<Replay />} />
        <Route path="/replay/:id" element={<Replay />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
