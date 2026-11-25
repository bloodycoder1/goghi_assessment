import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled UI error:', error.message, info.componentStack);
  }

  private handleReload = () => {
    this.setState({ hasError: false });
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[radial-gradient(ellipse_at_top_left,_#e3efe8_0%,_#f8fbf9_55%,_#fff5ec_100%)] flex items-center justify-center p-6">
          <div className="glass-panel max-w-md w-full rounded-3xl p-8 text-center space-y-5">
            <div className="mx-auto h-12 w-12 rounded-2xl bg-orange-100 border border-orange-200 flex items-center justify-center text-orange-600">
              <AlertTriangle className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-pine-900">Something went wrong</h2>
              <p className="text-sm text-pine-600 mt-1">
                An unexpected error occurred in the interface. Please reload to continue.
              </p>
            </div>
            <button
              type="button"
              onClick={this.handleReload}
              className="gloss-orange px-5 py-2.5 rounded-2xl text-white text-sm font-semibold inline-flex items-center gap-2 cursor-pointer"
            >
              <RotateCw className="h-4 w-4" />
              Reload Application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
