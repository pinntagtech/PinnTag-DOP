import { createContext, useContext, useState } from 'react';
import type { Environment } from '@pinntag-dop/types';

interface EnvironmentContextType {
  environment: Environment;
  setEnvironment: (env: Environment) => void;
}

const EnvironmentContext = createContext<EnvironmentContextType>({
  environment: 'dev',
  setEnvironment: () => {},
});

export function EnvironmentProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [environment, setEnvironment] = useState<Environment>('dev');
  return (
    <EnvironmentContext.Provider value={{ environment, setEnvironment }}>
      {children}
    </EnvironmentContext.Provider>
  );
}

export function useEnvironment() {
  return useContext(EnvironmentContext);
}
