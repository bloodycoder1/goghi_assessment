import { configureStore } from '@reduxjs/toolkit';
import {
  FLUSH,
  PAUSE,
  PERSIST,
  PURGE,
  REGISTER,
  REHYDRATE,
  persistReducer,
  persistStore,
  type Storage,
} from 'redux-persist';
import inboxReducer from './inboxSlice';

// Explicit async localStorage adapter avoids Vite CJS/ESM default-export interop issues with redux-persist.
const webStorage: Storage = {
  getItem: (key) => Promise.resolve(typeof window !== 'undefined' ? window.localStorage.getItem(key) : null),
  setItem: (key, value) => {
    if (typeof window !== 'undefined') window.localStorage.setItem(key, value);
    return Promise.resolve();
  },
  removeItem: (key) => {
    if (typeof window !== 'undefined') window.localStorage.removeItem(key);
    return Promise.resolve();
  },
};

const inboxPersistConfig = {
  key: 'switchboard_inbox',
  storage: webStorage,
  // Persist only non-sensitive UI navigation state; messages and auth stay in-memory/server-side.
  whitelist: ['selectedContact', 'statusFilter'],
};

const persistedInboxReducer = persistReducer(inboxPersistConfig, inboxReducer);

export const store = configureStore({
  reducer: {
    inbox: persistedInboxReducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: [FLUSH, REHYDRATE, PAUSE, PERSIST, PURGE, REGISTER],
      },
    }),
});

export const persistor = persistStore(store);

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
