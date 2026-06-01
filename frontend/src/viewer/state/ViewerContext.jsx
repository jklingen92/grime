// Viewer context: holds reducer state and exposes config + dispatch through
// React context. Components use the useViewerState / useViewerDispatch hooks
// to read or mutate state without prop-drilling.

import { createContext, useContext, useReducer, useMemo } from 'react';
import { reducer } from './reducer.js';
import { buildInitialState } from './initialState.js';

const StateContext = createContext(null);
const DispatchContext = createContext(null);
const ConfigContext = createContext(null);

export function ViewerProvider({ config, children }) {
  const [state, dispatch] = useReducer(reducer, config, buildInitialState);

  const dispatchValue = useMemo(() => dispatch, [dispatch]);

  return (
    <ConfigContext.Provider value={config}>
      <StateContext.Provider value={state}>
        <DispatchContext.Provider value={dispatchValue}>
          {children}
        </DispatchContext.Provider>
      </StateContext.Provider>
    </ConfigContext.Provider>
  );
}

export function useViewerState() {
  const v = useContext(StateContext);
  if (!v) throw new Error('useViewerState outside ViewerProvider');
  return v;
}

export function useViewerDispatch() {
  const v = useContext(DispatchContext);
  if (!v) throw new Error('useViewerDispatch outside ViewerProvider');
  return v;
}

export function useViewerConfig() {
  const v = useContext(ConfigContext);
  if (!v) throw new Error('useViewerConfig outside ViewerProvider');
  return v;
}
