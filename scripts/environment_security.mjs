const PROCESS_INJECTION_ENV_NAMES = new Set([
  'NODE_OPTIONS', 'NODE_PATH',
  'BASH_ENV', 'ENV', 'ZDOTDIR', 'CDPATH', 'GLOBIGNORE', 'SHELLOPTS', 'PS4',
  'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP',
  'RUBYOPT', 'RUBYLIB', 'PERL5OPT', 'PERL5LIB',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS',
  'GCONV_PATH', 'LOCPATH', 'NLSPATH',
])

export function forbiddenPlatformCredentialEnvironmentName(name) {
  const normalized = String(name || '').trim().toUpperCase()
  return /^KAIGONGBA_.*(?:TOKEN|SECRET|API_KEY|PASSWORD|CONNECT_CODE)$/.test(normalized)
    || normalized === 'KAIGONGBA_AGENT_TOKEN'
    || normalized === 'KAIGONGBA_CONNECT_CODE'
}

export function forbiddenExecutorEnvironmentName(name) {
  const normalized = String(name || '').trim().toUpperCase()
  return forbiddenPlatformCredentialEnvironmentName(normalized)
    || normalized.startsWith('LD_')
    || normalized.startsWith('DYLD_')
    || PROCESS_INJECTION_ENV_NAMES.has(normalized)
}

export function safeEnvironmentAdditions(additions = {}) {
  return Object.fromEntries(
    Object.entries(additions).filter(([name]) => !forbiddenExecutorEnvironmentName(name)),
  )
}
