import { Navigate, Outlet, Route, Routes, useParams } from "react-router-dom";

import { ProtectedRoute } from "./components/ProtectedRoute";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { MatrixProvider } from "./context/MatrixContext";
import { ChatPage } from "./pages/ChatPage";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";

function PublicOnly() {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <Navigate to="/chat" replace /> : <Outlet />;
}

function LegacyChannelRedirect() {
  const { conversationId } = useParams<{ conversationId: string }>();
  return <Navigate to={conversationId ? `/communities/${encodeURIComponent(conversationId)}` : "/communities"} replace />;
}

function RootRedirect() {
  const { isAuthenticated } = useAuth();
  return <Navigate to={isAuthenticated ? "/chat" : "/login"} replace />;
}

function NotFound() {
  const { isAuthenticated } = useAuth();
  return <Navigate to={isAuthenticated ? "/chat" : "/login"} replace />;
}

export function App() {
  return (
    <AuthProvider>
      <MatrixProvider>
        <Routes>
          <Route element={<PublicOnly />}>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
          </Route>
          <Route element={<ProtectedRoute />}>
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/chat/:conversationId" element={<ChatPage />} />
            <Route path="/groups" element={<ChatPage section="groups" />} />
            <Route path="/groups/:conversationId" element={<ChatPage section="groups" />} />
            <Route path="/contacts" element={<ChatPage section="contacts" />} />
            <Route path="/communities" element={<ChatPage section="channels" />} />
            <Route path="/communities/:conversationId" element={<ChatPage section="channels" />} />
            <Route path="/channels" element={<Navigate to="/communities" replace />} />
            <Route path="/channels/:conversationId" element={<LegacyChannelRedirect />} />
          </Route>
          <Route path="/" element={<RootRedirect />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </MatrixProvider>
    </AuthProvider>
  );
}
