import { ArrowRight, Eye, EyeOff, LockKeyhole, Mail, LoaderCircle } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { Brand } from "../components/Brand";
import { AuthLayout } from "../layouts/AuthLayout";
import { ApiError } from "../services/api/client";
import { useAuth } from "../context/AuthContext";

interface LoginLocationState {
  from?: { pathname?: string };
  notice?: string;
  login?: string;
}

export function LoginPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const routeState = location.state as LoginLocationState | null;
  const [login, setLogin] = useState(routeState?.login ?? "");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(routeState?.notice ?? "");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");
    if (!login.trim() || !password) {
      setError("Enter your email or username and password to continue.");
      return;
    }

    setSubmitting(true);
    try {
      await signIn({ login: login.trim(), password });
      navigate(routeState?.from?.pathname ?? "/chat", { replace: true });
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : "We couldn't sign you in. Check your connection and try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout>
      <section className="auth-card login-card" aria-labelledby="login-heading">
        <Brand />
        <div className="auth-heading">
          <h1 id="login-heading">Welcome back</h1>
          <p>Log in to continue your conversations</p>
        </div>

        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        {notice && !error && (
          <div className="form-notice" role="status">
            {notice}
          </div>
        )}

        <form className="auth-form" onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label htmlFor="login">Email or username</label>
            <div className="input-wrap">
              <Mail className="field-icon" size={18} aria-hidden="true" />
              <input
                id="login"
                name="login"
                value={login}
                onChange={(event) => setLogin(event.target.value)}
                placeholder="you@example.com"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={Boolean(error)}
              />
            </div>
          </div>

          <div className="field">
            <div className="field-label-row">
              <label htmlFor="password">Password</label>
              <button
                type="button"
                className="text-link"
                onClick={() => {
                  setError("");
                  setNotice(
                    "Password recovery is not available yet. Contact your administrator for help.",
                  );
                }}
              >
                Forgot password?
              </button>
            </div>
            <div className="input-wrap">
              <LockKeyhole className="field-icon" size={18} aria-hidden="true" />
              <input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter your password"
                autoComplete="current-password"
                aria-invalid={Boolean(error)}
              />
              <button
                type="button"
                className="password-toggle"
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((visible) => !visible)}
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          <button className="primary-button auth-submit" type="submit" disabled={submitting}>
            {submitting ? (
              <>
                <LoaderCircle size={18} className="spin" />
                <span>Signing in…</span>
              </>
            ) : (
              <>
                <span>Log In</span>
                <ArrowRight size={18} />
              </>
            )}
          </button>
        </form>

        <div className="auth-divider"><span>OR</span></div>
        <button
          type="button"
          className="secondary-button google-button"
          onClick={() => {
            setError("");
            setNotice("Google sign-in is not configured for this application yet.")
          }}
        >
          <span className="google-g" aria-hidden="true">G</span>
          Continue with Google
        </button>

        <p className="auth-switch">
          Don&apos;t have an account? <Link to="/register">Create an account</Link>
        </p>
      </section>
    </AuthLayout>
  );
}
