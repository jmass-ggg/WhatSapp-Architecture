import {
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  LockKeyhole,
  Mail,
  UserRound,
  LoaderCircle,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";

import { Brand } from "../components/Brand";
import { AuthLayout } from "../layouts/AuthLayout";
import { ApiError } from "../services/api/client";
import { useAuth } from "../context/AuthContext";

function suggestedUsername(email: string): string {
  const localPart = email.split("@")[0] ?? "";
  const cleaned = localPart
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 32);
  return cleaned.length >= 3 ? cleaned : "";
}

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [usernameEdited, setUsernameEdited] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!usernameEdited) setUsername(suggestedUsername(email));
  }, [email, usernameEdited]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setNotice("");

    if (fullName.trim().length < 1 || fullName.trim().length > 80) {
      setError("Enter a name between 1 and 80 characters.");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Enter a valid email address.");
      return;
    }
    if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/i.test(username.trim())) {
      setError("Your username must be 3–32 characters and start with a letter or number.");
      return;
    }
    if (password.length < 12 || password.length > 128) {
      setError("Use a password between 12 and 128 characters.");
      return;
    }
    if (confirmPassword !== password) {
      setError("The passwords don't match.");
      return;
    }
    if (!acceptedTerms) {
      setError("Accept the Terms of Service and Privacy Policy to create an account.");
      return;
    }

    setSubmitting(true);
    try {
      await register({
        email: email.trim(),
        username: username.trim(),
        password,
        display_name: fullName.trim(),
      });
      navigate("/login", {
        replace: true,
        state: {
          notice: "Your account is ready. Log in to open your Recruitable Chat and Matrix sessions.",
          login: email.trim(),
        },
      });
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : "We couldn't create your account. Check your connection and try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  const passwordLongEnough = password.length >= 12;

  return (
    <AuthLayout>
      <section className="auth-card register-card" aria-labelledby="register-heading">
        <Brand />
        <div className="auth-heading">
          <h1 id="register-heading">Create your account</h1>
          <p>A little more room for good conversations.</p>
        </div>

        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="form-notice" role="status">
            {notice}
          </div>
        )}

        <form className="auth-form register-form" onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label htmlFor="full-name">Full name</label>
            <div className="input-wrap">
              <UserRound className="field-icon" size={18} aria-hidden="true" />
              <input
                id="full-name"
                value={fullName}
                onChange={(event) => setFullName(event.target.value)}
                placeholder="How should we call you?"
                autoComplete="name"
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="register-email">Email address</label>
            <div className="input-wrap">
              <Mail className="field-icon" size={18} aria-hidden="true" />
              <input
                id="register-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                autoCapitalize="none"
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="register-username">Username</label>
            <div className="input-wrap">
              <span className="field-at" aria-hidden="true">@</span>
              <input
                id="register-username"
                value={username}
                onChange={(event) => {
                  setUsernameEdited(true);
                  setUsername(event.target.value);
                }}
                placeholder="yourname"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
              />
            </div>
            <span className="field-hint">This also identifies you in the Recruitable Chat directory.</span>
          </div>

          <div className="field">
            <label htmlFor="register-password">Password</label>
            <div className="input-wrap">
              <LockKeyhole className="field-icon" size={18} aria-hidden="true" />
              <input
                id="register-password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="At least 12 characters"
                autoComplete="new-password"
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
            <span className={`password-requirement${passwordLongEnough ? " met" : ""}`}>
              <Check size={14} aria-hidden="true" />
              Use at least 12 characters
            </span>
          </div>

          <div className="field">
            <label htmlFor="confirm-password">Confirm password</label>
            <div className="input-wrap">
              <LockKeyhole className="field-icon" size={18} aria-hidden="true" />
              <input
                id="confirm-password"
                type={showPassword ? "text" : "password"}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="Enter your password again"
                autoComplete="new-password"
              />
            </div>
          </div>

          <div className="terms-check">
            <input
              id="accept-terms"
              type="checkbox"
              checked={acceptedTerms}
              onChange={(event) => setAcceptedTerms(event.target.checked)}
            />
            <div>
              <label htmlFor="accept-terms">I agree to the </label>
              <button type="button" onClick={() => { setError(""); setNotice("Terms content is not available yet."); }}>Terms of Service</button>
              <span> and </span>
              <button type="button" onClick={() => { setError(""); setNotice("Privacy policy content is not available yet."); }}>Privacy Policy</button>
              <span>.</span>
            </div>
          </div>

          <button className="primary-button auth-submit" type="submit" disabled={submitting}>
            {submitting ? (
              <>
                <LoaderCircle size={18} className="spin" />
                <span>Creating account…</span>
              </>
            ) : (
              <>
                <span>Create Account</span>
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
            setNotice("Google sign-in is not configured for this application yet.");
          }}
        >
          <span className="google-g" aria-hidden="true">G</span>
          Continue with Google
        </button>
        <p className="auth-switch">
          Already have an account? <Link to="/login">Log in</Link>
        </p>
      </section>
    </AuthLayout>
  );
}
