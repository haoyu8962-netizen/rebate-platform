// Admin login pages (design-hifi AdmLogin, AdmLoginTotp, AdmLoginTotpBind, AdmLoginTotpBindInvalid,
// AdmLoginTotpBindDone; BR-ID-34), built from antd Form / Input / Steps / Alert (规划/03 §9.1).
// The step comes from the auth provider; each step moves focus to its title, errors use
// role=alert, and leaving the page discards the ticket and the binding secret. The
// change-password step has no artboard and reuses the AdmLogin layout.
import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import {
  CheckCircleOutlined,
  CopyOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  UserOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Avatar,
  Button,
  Card,
  ConfigProvider,
  Flex,
  Form,
  Input,
  QRCode,
  Result,
  Steps,
  Tag,
  Typography,
  type InputRef,
} from 'antd';
import { OTP_LENGTH, OtpInput } from '../../components/otp-input/index.ts';
import type { AdminAuthProvider, LoginError, LoginSnapshot } from '../../providers/auth/index.ts';
import type { AdminEnvironment } from '../../shell-options.ts';
import { useReducedMotion } from '../../motion.ts';
import { createAntdTheme } from '../../theme.ts';
import { ensureMatchMedia } from './media-query.ts';
import { isLoginTextKey, loginText, type LoginTextKey } from '../../texts/login.ts';
import './login.css';

export interface LoginPageProps {
  readonly authProvider: AdminAuthProvider;
  readonly environment: AdminEnvironment;
  readonly onComplete: () => void;
}

const SHANGHAI = 'Asia/Shanghai';

/** BR-TEXT-11 future time: same year「MM-DD HH:mm」, otherwise「YYYY-MM-DD HH:mm」(+08:00). */
function formatFuture(iso: string, now: number): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  const parts = (value: number) => {
    const map = new Map(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: SHANGHAI,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(value)
        .map((part) => [part.type, part.value]),
    );
    return {
      year: map.get('year') ?? '',
      date: `${map.get('month') ?? ''}-${map.get('day') ?? ''}`,
      time: `${map.get('hour') ?? ''}:${map.get('minute') ?? ''}`,
    };
  };
  const target = parts(time);
  const date = target.year === parts(now).year ? target.date : `${target.year}-${target.date}`;
  return `${date} ${target.time}`;
}

/** The line to show for a failed step (BR-TEXT-14). */
export function loginErrorText(error: LoginError, now = Date.now()): string {
  if (error.key === 'error.10009' && error.lockedUntil !== undefined)
    return loginText('error.10009', { unlock_time: formatFuture(error.lockedUntil, now) });
  if (error.key === 'error.5xxxx') {
    return error.traceId === undefined || error.traceId === ''
      ? loginText('error.5xxxx.no_trace')
      : loginText('error.5xxxx', { trace6: error.traceId.slice(-6) });
  }
  if (isLoginTextKey(error.key)) {
    if (error.key === 'error.unknown' && error.serverMessage !== undefined)
      return error.serverMessage;
    return loginText(error.key);
  }
  return loginText('error.unknown');
}

/** QR drawing size; the 148 × 148 frame (login.css) holds it with its quiet zone. */
const QR_SIZE = 120;

function groupSecret(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(' ');
}

type View = 'credentials' | 'change_password' | 'totp' | 'bind_totp' | 'done';

/** Role for the step bar; antd Steps forwards it to its root element. */
const STEPS_GROUP = { role: 'group' } as const;

/** Two-step bar: account and password, then the second step (antd Steps). */
function LoginSteps({
  second,
  stage,
}: {
  readonly second: string;
  readonly stage: 'first' | 'second' | 'done';
}) {
  // antd Steps has no list semantics of its own: name the bar and mark the current step.
  const current = { 'aria-current': 'step' } as const;
  return (
    <Steps
      {...STEPS_GROUP}
      aria-label={loginText('steps.label')}
      size="small"
      responsive={false}
      className="login-progress"
      items={[
        {
          title: loginText('steps.credentials'),
          status: stage === 'first' ? 'process' : 'finish',
          ...(stage === 'first' ? current : {}),
        },
        {
          title: second,
          status: stage === 'first' ? 'wait' : stage === 'second' ? 'process' : 'finish',
          ...(stage === 'second' ? current : {}),
        },
      ]}
    />
  );
}

interface FieldProps {
  readonly label: string;
  /** Value when the field mounts; afterwards the field keeps its own value. */
  readonly initial: string;
  /** Mirrors every change to the page (read on submit), without re-rendering the page. */
  readonly onValue: (value: string) => void;
  readonly password?: boolean;
  readonly autoComplete: string;
  readonly required?: boolean;
  readonly error?: string | undefined;
  readonly inputRef?: Ref<InputRef>;
}

/**
 * Show / hide password as a real antd Button (focusable, named, aria-pressed); Input.Password
 * clones it and adds the toggling onClick, so Enter and Space work from the keyboard.
 */
function renderVisibilityToggle(visible: boolean): ReactNode {
  return (
    <Button
      type="text"
      size="small"
      aria-label={loginText(visible ? 'credentials.hide_password' : 'credentials.show_password')}
      aria-pressed={visible}
      icon={visible ? <EyeOutlined /> : <EyeInvisibleOutlined />}
    />
  );
}

/**
 * One labelled antd Input in a Form.Item; local and server (20001) errors show on the item.
 * Typing re-renders only this field: the page reads the values when it submits.
 */
const Field = memo(function Field({
  label,
  initial,
  onValue,
  password,
  autoComplete,
  required,
  error,
  inputRef,
}: FieldProps) {
  const id = useId();
  const errorId = useId();
  const [value, setValue] = useState(initial);
  const invalid = error !== undefined;
  const inputProps = {
    id,
    ref: inputRef,
    value,
    autoComplete,
    'aria-required': required === true ? true : undefined,
    'aria-invalid': invalid ? true : undefined,
    'aria-describedby': invalid ? errorId : undefined,
    onChange: (event: { target: { value: string } }) => {
      setValue(event.target.value);
      onValue(event.target.value);
    },
  };
  return (
    <Form.Item
      label={label}
      htmlFor={id}
      required={required === true}
      validateStatus={invalid ? 'error' : ''}
      help={invalid ? <span id={errorId}>{error}</span> : undefined}
    >
      {password === true ? (
        <Input.Password {...inputProps} iconRender={renderVisibilityToggle} />
      ) : (
        <Input {...inputProps} />
      )}
    </Form.Item>
  );
});

function ErrorBanner({ text }: { readonly text: string }) {
  return <Alert type="error" showIcon message={text} />;
}

/** Explanations, not alerts: role=note keeps role=alert for errors only. */
function InfoBanner({ text }: { readonly text: string }) {
  return <Alert type="info" showIcon role="note" message={text} />;
}

/** 42901: submit stays disabled for Retry-After seconds (default 5) from the error's arrival. */
function useCooldown(error: LoginError | undefined): boolean {
  const [cooled, setCooled] = useState<LoginError | undefined>(undefined);
  useEffect(() => {
    const seconds = error?.retryAfterSeconds;
    if (error === undefined || seconds === undefined) return undefined;
    const timer = setTimeout(() => setCooled(error), seconds * 1000);
    return () => clearTimeout(timer);
  }, [error]);
  return error?.retryAfterSeconds !== undefined && cooled !== error;
}

type FieldCheck = readonly [RefObject<InputRef | null>, boolean];

function isCodeError(error: LoginError | undefined): boolean {
  return error?.key.startsWith('error.20002') === true;
}

interface CodeFormProps {
  /** The provider's current error: a new wrong-code error (20002) empties the cells. */
  readonly error: LoginError | undefined;
  readonly readError: () => LoginError | undefined;
  readonly disabled: boolean;
  readonly submitLabel: string;
  readonly label: string;
  readonly hint: string;
  readonly invalid: boolean;
  readonly errorText: string | undefined;
  readonly inputRef: Ref<HTMLInputElement>;
  readonly onSubmit: (code: string) => void;
  /** Lays out the code input and the submit button among the page's other (unchanged) parts. */
  readonly layout: (input: ReactElement, submit: ReactElement) => ReactNode;
}

/** The dynamic-code form; typing a digit re-renders only this form, not the page. */
function CodeForm({
  error,
  readError,
  disabled,
  submitLabel,
  label,
  hint,
  invalid,
  errorText,
  inputRef,
  onSubmit,
  layout,
}: CodeFormProps) {
  // A wrong code (20002) empties the cells in the same render that shows the error; digits typed
  // after that error are kept.
  const [codeState, setCodeState] = useState<{
    readonly value: string;
    readonly seenError: LoginError | undefined;
  }>({ value: '', seenError: undefined });
  const code = codeState.seenError !== error && isCodeError(error) ? '' : codeState.value;
  const setCode = (value: string): void => setCodeState({ value, seenError: readError() });
  const submit = (): void => onSubmit(code);
  return (
    <Form layout="vertical" onFinish={submit}>
      <Flex vertical gap="large">
        {layout(
          <OtpInput
            value={code}
            onChange={setCode}
            label={label}
            hint={hint}
            invalid={invalid}
            error={errorText}
            inputRef={inputRef}
            onEnter={submit}
          />,
          <Button
            type="primary"
            htmlType="submit"
            size="large"
            block
            disabled={disabled || code.length !== OTP_LENGTH}
          >
            {submitLabel}
          </Button>,
        )}
      </Flex>
    </Form>
  );
}

/** Two-character Chinese buttons keep their text as written (no inserted space). */
const BUTTON_CONFIG = { autoInsertSpace: false } as const;

type TypedField = 'username' | 'password' | 'newPassword' | 'confirmPassword';

/** The page's copy of the typed values: written on each keystroke, read on submit and mount. */
class TypedValues {
  private readonly values: Record<TypedField, string> = {
    username: '',
    password: '',
    newPassword: '',
    confirmPassword: '',
  };

  private readonly setters = new Map<TypedField, (value: string) => void>();

  get(name: TypedField): string {
    return this.values[name];
  }

  set(name: TypedField, value: string): void {
    this.values[name] = value;
  }

  /** A stable setter per field, so the memoised fields are not re-rendered by the page. */
  setter(name: TypedField): (value: string) => void {
    let setter = this.setters.get(name);
    if (setter === undefined) {
      setter = (value) => this.set(name, value);
      this.setters.set(name, setter);
    }
    return setter;
  }
}

export function LoginPage({ authProvider, environment, onComplete }: LoginPageProps): ReactElement {
  const snapshot: LoginSnapshot = useSyncExternalStore(
    authProvider.subscribe,
    authProvider.getSnapshot,
    authProvider.getSnapshot,
  );
  // The login page also renders on its own (outside the app's ConfigProvider).
  // Reduced motion (规划/03 §10.6 第 8 条) switches antd motion off here too.
  const reducedMotion = useReducedMotion();
  const theme = useMemo(() => {
    ensureMatchMedia();
    return createAntdTheme(document.documentElement, { reducedMotion });
  }, [reducedMotion]);
  // What the user typed lives in the fields; the page keeps a copy for submitting and only
  // re-renders on its own state (step, errors, submitting), not on every keystroke.
  const [typed] = useState(() => new TypedValues());
  const [submitting, setSubmitting] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const [copied, setCopied] = useState(false);
  const headingRef = useRef<HTMLElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<InputRef>(null);
  const passwordRef = useRef<InputRef>(null);
  const newPasswordRef = useRef<InputRef>(null);
  const confirmRef = useRef<InputRef>(null);
  const mounted = useRef(true);
  // Bumped by each submit and by leaving the account (换账号 / 返回上一步): an abandoned request
  // no longer holds the buttons disabled or moves focus on the new attempt.
  const runId = useRef(0);
  const cooling = useCooldown(snapshot.error);

  // A dynamic-code login stays on its page until the shell takes over; a binding shows its done
  // page. Both come from the same provider update, so no step flashes in between.
  const view: View =
    snapshot.step === 'done' ? (snapshot.bound === true ? 'done' : 'totp') : snapshot.step;

  // 20001: the fields the server named (data.fields) are marked beside their inputs.
  const serverFields = new Set(snapshot.error?.fields ?? []);
  const fieldError = (local: string | undefined, ...names: string[]): string | undefined =>
    local ??
    (names.some((name) => serverFields.has(name)) ? loginText('field.invalid') : undefined);

  // Leaving the page (route change, unmount) voids the ticket and the binding secret.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      authProvider.resetLogin();
    };
  }, [authProvider]);

  // Each step announces itself by moving focus to its title.
  useEffect(() => {
    headingRef.current?.focus();
  }, [view]);

  // A step change starts with empty inputs (the secret is never kept beyond its step).
  const [shownView, setShownView] = useState(view);
  if (shownView !== view) {
    setShownView(view);
    setCopied(false);
    setFieldErrors({});
    // Each step's form mounts afresh (keyed by step) and starts from these values.
    if (view === 'credentials') typed.set('password', '');
    if (view !== 'change_password') {
      typed.set('newPassword', '');
      typed.set('confirmPassword', '');
    }
  }

  /** The request's outcome, or undefined when it was abandoned meanwhile (or the page left). */
  async function run(
    work: () => ReturnType<AdminAuthProvider['login']>,
  ): Promise<boolean | undefined> {
    runId.current += 1;
    const mine = runId.current;
    setSubmitting(true);
    let success = false;
    try {
      success = (await work()).success;
    } finally {
      if (mounted.current && runId.current === mine) setSubmitting(false);
    }
    return mounted.current && runId.current === mine ? success : undefined;
  }

  /** Moves focus to the first field named by a local check or by the server (20001). */
  function focusFirst(fields: readonly FieldCheck[]): void {
    for (const [ref, invalid] of fields) {
      if (invalid) {
        ref.current?.focus();
        return;
      }
    }
  }

  function rejectedFields(): Set<string> {
    return new Set(authProvider.getSnapshot().error?.fields ?? []);
  }

  async function submitCredentials(): Promise<void> {
    if (submitting || cooling) return;
    const username = typed.get('username');
    const password = typed.get('password');
    const errors: Record<string, string> = {};
    if (username.trim() === '') errors['username'] = loginText('field.username_required');
    if (password === '') errors['password'] = loginText('field.password_required');
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      focusFirst([
        [usernameRef, errors['username'] !== undefined],
        [passwordRef, errors['password'] !== undefined],
      ]);
      return;
    }
    const ok = await run(() =>
      authProvider.login({ step: 'credentials', username: username.trim(), password }),
    );
    if (ok !== false) return;
    const rejected = rejectedFields();
    focusFirst([
      [usernameRef, rejected.has('username')],
      [passwordRef, rejected.has('password')],
    ]);
  }

  async function submitPassword(): Promise<void> {
    if (submitting || cooling) return;
    const newPassword = typed.get('newPassword');
    const confirmPassword = typed.get('confirmPassword');
    const errors: Record<string, string> = {};
    if (newPassword === '') errors['newPassword'] = loginText('password.new_required');
    else if (confirmPassword !== newPassword) errors['confirm'] = loginText('password.mismatch');
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      focusFirst([
        [newPasswordRef, errors['newPassword'] !== undefined],
        [confirmRef, errors['confirm'] !== undefined],
      ]);
      return;
    }
    const ok = await run(() => authProvider.login({ step: 'change_password', newPassword }));
    if (ok !== false) return;
    focusFirst([[newPasswordRef, rejectedFields().has('new_password')]]);
  }

  async function submitCode(step: 'totp' | 'bind_totp', code: string): Promise<void> {
    if (submitting || cooling || code.length !== OTP_LENGTH) return;
    const ok = await run(() => authProvider.login({ step, code }));
    if (ok === undefined) return;
    if (ok) {
      // A binding shows its done page first (「进入后台」); a dynamic code enters directly.
      if (step === 'totp') onComplete();
      return;
    }
    const error = authProvider.getSnapshot().error;
    if (isCodeError(error) || error?.fields?.includes('code') === true) codeRef.current?.focus();
  }

  function enter(): void {
    // The session may have ended while the done page waited; the provider then shows step one.
    if (authProvider.getToken() !== null) onComplete();
  }

  function backToStart(keepUsername: boolean): void {
    runId.current += 1;
    setSubmitting(false);
    authProvider.resetLogin();
    if (!keepUsername) typed.set('username', '');
    typed.set('password', '');
  }

  async function copySecret(secret: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(secret);
      if (mounted.current) setCopied(true);
    } catch {
      // Clipboard refused: the grouped secret stays on screen for manual entry.
    }
  }

  const errorText = snapshot.error === undefined ? undefined : loginErrorText(snapshot.error);
  const blocked = submitting || cooling;
  const codeInvalid = isCodeError(snapshot.error) || serverFields.has('code');
  const readError = (): LoginError | undefined => authProvider.getSnapshot().error;

  let titleKey: LoginTextKey = 'credentials.title';
  let body: ReactNode = null;
  let wide = false;

  const backRow = (help: string) => (
    <Flex align="center" justify="space-between">
      <Button type="link" onClick={() => backToStart(true)}>
        {loginText('back')}
      </Button>
      <Typography.Text type="secondary">{help}</Typography.Text>
    </Flex>
  );

  switch (view) {
    case 'credentials':
      titleKey = 'credentials.title';
      body = (
        <>
          <LoginSteps second={loginText('steps.totp')} stage="first" />
          <Form key={view} layout="vertical" onFinish={() => void submitCredentials()}>
            <Field
              label={loginText('credentials.username')}
              initial={typed.get('username')}
              onValue={typed.setter('username')}
              autoComplete="username"
              required
              inputRef={usernameRef}
              error={fieldError(fieldErrors['username'], 'username')}
            />
            <Field
              label={loginText('credentials.password')}
              initial={typed.get('password')}
              onValue={typed.setter('password')}
              password
              autoComplete="current-password"
              required
              inputRef={passwordRef}
              error={fieldError(fieldErrors['password'], 'password')}
            />
            <Flex vertical gap="middle">
              {errorText === undefined ? null : <ErrorBanner text={errorText} />}
              <Button type="primary" htmlType="submit" size="large" block disabled={blocked}>
                {loginText('next')}
              </Button>
              <InfoBanner text={loginText('credentials.note')} />
            </Flex>
          </Form>
        </>
      );
      break;

    case 'change_password':
      titleKey = 'password.title';
      body = (
        <>
          <LoginSteps second={loginText('password.step')} stage="second" />
          <AccountRow username={snapshot.username} onSwitch={() => backToStart(false)} />
          <InfoBanner text={loginText('password.intro')} />
          <Form key={view} layout="vertical" onFinish={() => void submitPassword()}>
            <Field
              label={loginText('password.new')}
              initial={typed.get('newPassword')}
              onValue={typed.setter('newPassword')}
              password
              autoComplete="new-password"
              inputRef={newPasswordRef}
              error={fieldError(fieldErrors['newPassword'], 'new_password')}
            />
            <Field
              label={loginText('password.confirm')}
              initial={typed.get('confirmPassword')}
              onValue={typed.setter('confirmPassword')}
              password
              autoComplete="new-password"
              inputRef={confirmRef}
              error={fieldErrors['confirm']}
            />
            <Flex vertical gap="middle">
              {errorText === undefined ? null : <ErrorBanner text={errorText} />}
              <Button type="primary" htmlType="submit" size="large" block disabled={blocked}>
                {loginText('next')}
              </Button>
              <Flex>
                <Button type="link" onClick={() => backToStart(true)}>
                  {loginText('back')}
                </Button>
              </Flex>
            </Flex>
          </Form>
        </>
      );
      break;

    case 'totp': {
      titleKey = 'totp.title';
      const totpBack = backRow(loginText('totp.help'));
      body = (
        <>
          <LoginSteps second={loginText('steps.totp')} stage="second" />
          <AccountRow username={snapshot.username} onSwitch={() => backToStart(false)} />
          <CodeForm
            key={view}
            error={snapshot.error}
            readError={readError}
            disabled={blocked}
            submitLabel={loginText('totp.submit')}
            label={loginText('totp.label')}
            hint={loginText('totp.hint')}
            invalid={codeInvalid}
            errorText={errorText}
            inputRef={codeRef}
            onSubmit={(code) => void submitCode('totp', code)}
            layout={(input, submit) => (
              <>
                {input}
                {submit}
                {totpBack}
              </>
            )}
          />
        </>
      );
      break;
    }

    case 'bind_totp': {
      wide = true;
      titleKey = 'bind.title';
      const secret = snapshot.secret;
      const invalid = isCodeError(snapshot.error);
      // The secret could not be fetched: the ticket is kept, only the secret is asked again.
      const secretFailed =
        secret === undefined && snapshot.secretLoading !== true && snapshot.error !== undefined;
      const bindIntro = (
        <>
          <BindStep number={1} title={loginText('bind.step1')}>
            <Typography.Text type="secondary">{loginText('bind.step1_hint')}</Typography.Text>
          </BindStep>
          <BindStep number={2} title={loginText('bind.step2')}>
            <Flex gap="large" align="flex-start">
              <div
                className="login-qr"
                role="img"
                aria-label={loginText('bind.qr_label')}
                data-drawn={secret === undefined ? undefined : ''}
              >
                {/* Drawn only from this account's current URI; nothing before the secret. */}
                {secret === undefined ? null : (
                  <QRCode
                    value={secret.otpauth_uri}
                    type="svg"
                    errorLevel="M"
                    bordered={false}
                    color="currentColor"
                    bgColor="transparent"
                    size={QR_SIZE}
                    aria-hidden="true"
                  />
                )}
              </div>
              <Flex vertical gap={4} className="login-bind-manual">
                <Typography.Text type="secondary">{loginText('bind.manual')}</Typography.Text>
                <Typography.Text type="secondary">
                  {loginText('bind.account_label')}
                </Typography.Text>
                <Typography.Text>
                  {loginText('bind.account_value', { username: snapshot.username })}
                </Typography.Text>
                <Typography.Text type="secondary">{loginText('bind.secret_label')}</Typography.Text>
                <Typography.Text strong code>
                  {secret !== undefined
                    ? groupSecret(secret.totp_secret)
                    : snapshot.secretLoading === true
                      ? loginText('bind.secret_loading')
                      : ''}
                </Typography.Text>
                <Flex align="center" gap="small">
                  {secretFailed ? (
                    <Button
                      type="link"

                      disabled={blocked}
                      onClick={() => void authProvider.retryBindingSecret()}
                    >
                      {loginText('bind.secret_retry')}
                    </Button>
                  ) : (
                    <Button
                      type="link"

                      icon={<CopyOutlined aria-hidden="true" />}
                      disabled={secret === undefined}
                      onClick={() => {
                        if (secret !== undefined) void copySecret(secret.totp_secret);
                      }}
                    >
                      {loginText('bind.copy')}
                    </Button>
                  )}
                  <Typography.Text type="success" role="status">
                    {copied ? loginText('bind.copied') : ''}
                  </Typography.Text>
                </Flex>
                <Typography.Text type="secondary">{loginText('bind.type')}</Typography.Text>
              </Flex>
            </Flex>
          </BindStep>
        </>
      );
      const bindEnd = (
        <>
          {backRow(loginText('bind.help'))}
          <Typography.Text type="secondary">{loginText('bind.leave_note')}</Typography.Text>
        </>
      );
      body = (
        <>
          <LoginSteps second={loginText('steps.bind')} stage="second" />
          <AccountRow
            username={snapshot.username}
            tag={loginText('bind.pending_tag')}
            onSwitch={() => backToStart(false)}
          />
          {invalid ? (
            // The code error itself is the alert under the cells; this explains the state.
            <Alert
              type="error"
              showIcon
              role="status"
              message={loginText('bind.invalid_title')}
              description={loginText('bind.invalid_desc')}
            />
          ) : (
            <InfoBanner text={loginText('bind.intro')} />
          )}
          {secretFailed && errorText !== undefined ? <ErrorBanner text={errorText} /> : null}
          <CodeForm
            key={view}
            error={snapshot.error}
            readError={readError}
            disabled={blocked || secret === undefined}
            submitLabel={loginText('bind.submit')}
            label={loginText('bind.label')}
            hint={loginText('bind.hint')}
            invalid={codeInvalid}
            errorText={secretFailed ? undefined : errorText}
            inputRef={codeRef}
            onSubmit={(code) => void submitCode('bind_totp', code)}
            layout={(input, submit) => (
              <>
                {bindIntro}
                <BindStep number={3} title={loginText('bind.step3')}>
                  {input}
                </BindStep>
                {submit}
                {bindEnd}
              </>
            )}
          />
        </>
      );
      break;
    }

    case 'done':
      wide = true;
      titleKey = 'done.title';
      body = (
        <>
          <LoginSteps second={loginText('steps.bind')} stage="done" />
          <AccountRow username={snapshot.username} tag={loginText('done.bound_tag')} tagDone />
          <Result
            status="success"
            className="login-result"
            title={
              <Typography.Title
                level={4}
                ref={headingRef}
                tabIndex={-1}
                className="login-focus-title"
              >
                {loginText('done.title')}
              </Typography.Title>
            }
            subTitle={loginText('done.desc', { username: snapshot.username })}
          />
          <Card size="small" title={loginText('done.landing_title')}>
            <Flex vertical gap={4}>
              <LandingLine text={loginText('done.landing_with')} />
              <LandingLine text={loginText('done.landing_without')} />
            </Flex>
          </Card>
          <Form layout="vertical" onFinish={enter}>
            <Flex vertical gap="middle" align="center">
              <Button type="primary" htmlType="submit" size="large" block>
                {loginText('done.enter')}
              </Button>
              <Typography.Text type="secondary">{loginText('done.lost')}</Typography.Text>
            </Flex>
          </Form>
        </>
      );
      break;
  }

  return (
    <ConfigProvider theme={theme} button={BUTTON_CONFIG}>
      <Flex vertical align="center" justify="center" gap="large" className="login-page">
        <Card className="login-card" data-wide={wide ? '' : undefined}>
          <Flex vertical gap="large">
            <Flex vertical align="center" gap="small">
              <Avatar shape="square" size={48} className="login-logo" aria-hidden="true">
                {loginText('brand.logo')}
              </Avatar>
              <Typography.Text strong className="login-brand">
                {loginText('brand')}
              </Typography.Text>
              {view === 'done' ? (
                <Typography.Text type="secondary">{loginText('done.subtitle')}</Typography.Text>
              ) : (
                <Typography.Title
                  level={5}
                  ref={headingRef}
                  tabIndex={-1}
                  className="login-focus-title"
                  style={{ margin: 0 }}
                >
                  {loginText(titleKey)}
                </Typography.Title>
              )}
            </Flex>
            {body}
          </Flex>
        </Card>
        <Typography.Text type="secondary">{loginText('footer')}</Typography.Text>
        {environment === 'production' ? null : (
          <Tag color="warning" bordered={false} className="login-env">
            {loginText('env.test')}
          </Tag>
        )}
      </Flex>
    </ConfigProvider>
  );
}

function LandingLine({ text }: { readonly text: string }) {
  return (
    <Flex gap="small">
      <Typography.Text type="secondary" aria-hidden="true">
        ·
      </Typography.Text>
      <Typography.Text>{text}</Typography.Text>
    </Flex>
  );
}

/** Numbered instruction of the binding page; the number is decoration. */
function BindStep({
  number,
  title,
  children,
}: {
  readonly number: number;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Flex gap="small" align="flex-start">
      <Avatar size={24} className="login-bind-number" aria-hidden="true">
        {number}
      </Avatar>
      <Flex vertical gap="small" className="login-bind-body">
        <Typography.Text strong>{title}</Typography.Text>
        {children}
      </Flex>
    </Flex>
  );
}

interface AccountRowProps {
  readonly username: string;
  readonly tag?: string;
  readonly tagDone?: boolean;
  readonly onSwitch?: () => void;
}

function AccountRow({ username, tag, tagDone, onSwitch }: AccountRowProps) {
  return (
    <Flex align="center" justify="space-between" className="login-account">
      <Flex align="center" gap="small">
        <Avatar size="small" icon={<UserOutlined aria-hidden="true" />} />
        <Typography.Text>{username}</Typography.Text>
        {tag === undefined ? null : (
          <Tag
            bordered={false}
            color={tagDone === true ? 'success' : 'processing'}
            icon={tagDone === true ? <CheckCircleOutlined aria-hidden="true" /> : undefined}
          >
            {tag}
          </Tag>
        )}
      </Flex>
      {onSwitch === undefined ? null : (
        <Button type="link" onClick={onSwitch}>
          {loginText('switch_account')}
        </Button>
      )}
    </Flex>
  );
}
