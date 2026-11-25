import { configureStore } from '@reduxjs/toolkit';
import inboxReducer from './inboxSlice';

export const store = configureStore({
  reducer: {
    inbox: inboxReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
