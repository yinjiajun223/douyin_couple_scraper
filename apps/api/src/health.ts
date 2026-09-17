export interface ReadinessCheck {
  check: () => Promise<void>;
  required: boolean;
}

export type ReadinessChecks = Record<string, ReadinessCheck>;

export interface ReadinessComponent {
  errorType?: string;
  required: boolean;
  status: 'down' | 'up';
}

export interface ReadinessReport {
  components: Record<string, ReadinessComponent>;
  status: 'degraded' | 'ok' | 'unavailable';
}

export async function runReadinessChecks(checks: ReadinessChecks): Promise<ReadinessReport> {
  const entries = await Promise.all(
    Object.entries(checks).map(async ([name, readinessCheck]) => {
      try {
        await readinessCheck.check();
        return [name, { required: readinessCheck.required, status: 'up' as const }] as const;
      } catch (error) {
        return [
          name,
          {
            errorType: error instanceof Error ? error.name : 'UnknownError',
            required: readinessCheck.required,
            status: 'down' as const,
          },
        ] as const;
      }
    }),
  );
  const components: Record<string, ReadinessComponent> = Object.fromEntries(entries);
  const requiredFailure = Object.values(components).some(
    (component) => component.required && component.status === 'down',
  );
  const optionalFailure = Object.values(components).some(
    (component) => !component.required && component.status === 'down',
  );

  return {
    components,
    status: requiredFailure ? 'unavailable' : optionalFailure ? 'degraded' : 'ok',
  };
}
