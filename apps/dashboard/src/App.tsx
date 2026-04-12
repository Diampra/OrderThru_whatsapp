import { useState, useMemo, useEffect, Fragment } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import { api, type DashboardSummary, type Product, type Order, type Review, type Role, type Tenant, type ProductSchemaItem, type StaffAlert } from './lib/api';

const statusOptions = ['PENDING', 'PREPARING', 'READY', 'COMPLETED'] as const;

function formatPrice(value: string | number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
  }).format(Number(value));
}

type LoginResponse = {
  accessToken: string;
  user: {
    id: string;
    email: string;
    role: Role;
    tenantId: string | null;
  };
};

type ProductFormState = {
  name: string;
  description: string;
  price: string;
  category: string;
  imageUrl: string;
  tags_raw: string;
  isAvailable: boolean;
  attributes: Record<string, any>;
};

const emptyProductForm: ProductFormState = {
  name: '',
  description: '',
  price: '',
  category: 'General',
  imageUrl: '',
  tags_raw: '',
  isAvailable: true,
  attributes: {},
};

export default function App() {
  const queryClient = useQueryClient();
  const [credentials, setCredentials] = useState({
    email: '',
    password: '',
  });
  const [productForm, setProductForm] = useState<ProductFormState>(emptyProductForm);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [editingTenant, setEditingTenant] = useState<Tenant | null>(null);
  const [activeTab, setActiveTab]= useState<'dashboard' | 'settings'>('dashboard');
  const [localSchema, setLocalSchema] = useState<ProductSchemaItem[]>([]);
  
  const token = window.localStorage.getItem('restaurant_admin_token');
  const userStr = window.localStorage.getItem('restaurant_admin_user');
  const currentUser = useMemo(() => userStr ? JSON.parse(userStr) as LoginResponse['user'] : null, [userStr]);

  const [recentOrders, setRecentOrders] = useState<Set<string>>(new Set());
  const [now, setNow] = useState(new Date());

  // Reply state
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyMessage, setReplyMessage] = useState('');

  // Manual Order state
  const [isManualModalOpen, setIsManualModalOpen] = useState(false);
  const [manualPhone, setManualPhone] = useState('');
  const [manualItems, setManualItems] = useState<{productId: string, quantity: number}[]>([]);
  
  // Toast state
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  // Force re-render every minute for delayed status updates
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (editingTenant) {
      setLocalSchema(editingTenant.productSchema || []);
    } else {
      setLocalSchema([]);
    }
  }, [editingTenant]);

  const addField = () => {
    setLocalSchema(prev => [
      ...prev,
      { name: `field_${Date.now()}`, label: 'New Field', type: 'text', required: false }
    ]);
  };

  const updateField = (index: number, updates: Partial<ProductSchemaItem>) => {
    setLocalSchema(prev => {
      const next = [...prev];
      next[index] = { ...next[index], ...updates };
      return next;
    });
  };

  const removeField = (index: number) => {
    setLocalSchema(prev => prev.filter((_, i) => i !== index));
  };

  const maskId = (id: string) => `#${id.slice(-7).toUpperCase()}`;

  const getOrderStatusStyles = (order: Order) => {
    if (recentOrders.has(order.id)) {
      return 'bg-emerald-50 ring-2 ring-emerald-500 ring-inset';
    }
    
    if (order.status === 'PENDING') {
      const created = new Date(order.createdAt);
      const diffMins = (now.getTime() - created.getTime()) / 60000;
      
      if (diffMins > 10) return 'bg-rose-50 ring-1 ring-rose-200';
      if (diffMins > 5) return 'bg-amber-50 ring-1 ring-amber-200';
    }
    
    return '';
  };

  // Real-time synchronization
  useEffect(() => {
    if (token && currentUser?.tenantId && currentUser.role === 'TENANT_ADMIN') {
      const socket = io(import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000', {
        transports: ['websocket'],
      });

      socket.on('connect', () => {
        socket.emit('joinTenant', currentUser.tenantId);
      });

      socket.on('staff.notification', () => {
        const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
        audio.play().catch(e => console.error('Audio playback failed:', e));
        // Refresh alerts from DB
        queryClient.invalidateQueries({ queryKey: ['staff-alerts'] });
      });

      socket.on('order.created', (order: Order) => {
        // Play notification sound
        const audio = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
        audio.play().catch(e => console.error('Audio playback failed:', e));
        
        // Highlight logic
        setRecentOrders(prev => {
          const next = new Set(prev);
          next.add(order.id);
          return next;
        });

        // Remove highlight after 30 seconds
        setTimeout(() => {
          setRecentOrders(prev => {
            const next = new Set(prev);
            next.delete(order.id);
            return next;
          });
        }, 30000);

        // Refresh data
        queryClient.invalidateQueries({ queryKey: ['orders'] });
        queryClient.invalidateQueries({ queryKey: ['summary'] });
      });

      return () => {
        socket.disconnect();
      };
    }
  }, [token, currentUser?.tenantId, currentUser?.role, queryClient]);

  const loginMutation = useMutation({
    mutationFn: async () => {
      const response = await api.post<LoginResponse>('/auth/login', credentials);
      return response.data;
    },
    onSuccess: (data) => {
      window.localStorage.setItem('restaurant_admin_token', data.accessToken);
      window.localStorage.setItem('restaurant_admin_user', JSON.stringify(data.user));
      queryClient.invalidateQueries();
      window.location.reload();
    },
  });

  const summaryQuery = useQuery({
    queryKey: ['summary'],
    queryFn: async () => (await api.get<DashboardSummary>('/dashboard/summary')).data,
    enabled: Boolean(token) && currentUser?.role === 'TENANT_ADMIN',
  });

  const ordersQuery = useQuery({
    queryKey: ['orders'],
    queryFn: async () => (await api.get<Order[]>('/orders')).data,
    enabled: Boolean(token) && currentUser?.role === 'TENANT_ADMIN',
  });

  const productsQuery = useQuery({
    queryKey: ['products'],
    queryFn: async () => (await api.get<Product[]>('/product/admin/all')).data,
    enabled: Boolean(token) && currentUser?.role === 'TENANT_ADMIN',
  });

  const productQuery = useQuery({
    queryKey: ['products-admin'],
    queryFn: async () => (await api.get<Product[]>('/product/admin/all')).data,
    enabled: Boolean(token) && currentUser?.role === 'TENANT_ADMIN',
  });

  const tenantQuery = useQuery({
    queryKey: ['current-tenant'],
    queryFn: async () => (await api.get<Tenant>(`/tenants/admin/me`)).data,
    enabled: Boolean(token) && currentUser?.role === 'TENANT_ADMIN',
  });

  const allTenantsQuery = useQuery({
    queryKey: ['all-tenants'],
    queryFn: async () => (await api.get<Tenant[]>('/tenants')).data,
    enabled: Boolean(token) && currentUser?.role === 'SUPER_ADMIN',
  });

  const reviewsQuery = useQuery({
    queryKey: ['reviews'],
    queryFn: async () => (await api.get<Review[]>('/reviews')).data,
    enabled: Boolean(token) && currentUser?.role === 'TENANT_ADMIN',
  });

  const alertsQuery = useQuery({
    queryKey: ['staff-alerts'],
    queryFn: async () => (await api.get<StaffAlert[]>('/dashboard/alerts')).data,
    enabled: Boolean(token) && currentUser?.role === 'TENANT_ADMIN',
  });

  const dismissAlertMutation = useMutation({
    mutationFn: async (alertId: string) =>
      api.patch(`/dashboard/alerts/${alertId}/dismiss`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['staff-alerts'] });
    },
  });

  const replyMutation = useMutation({
    mutationFn: async ({ customerPhone, message }: { customerPhone: string; message: string }) =>
      api.post('/dashboard/reply', { customerPhone, message }),
    onSuccess: () => {
      setReplyingTo(null);
      setReplyMessage('');
      showToast('Reply sent successfully! 🚀');
    },
    onError: (err: any) => {
      console.error('Reply failed:', err);
      showToast('Failed to send reply. Please try again.', 'error');
    }
  });

  const manualOrderMutation = useMutation({
    mutationFn: async ({ customerPhone, items }: { customerPhone: string; items: any[] }) =>
      api.post('/dashboard/manual-order', { customerPhone, items }),
    onSuccess: () => {
      setIsManualModalOpen(false);
      setManualPhone('');
      setManualItems([]);
      showToast('Manual order placed successfully! 🛒');
      queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (err: any) => {
      alert('Failed to place manual order: ' + (err.response?.data?.message || err.message));
    }
  });

  const statusMutation = useMutation({
    mutationFn: async ({ orderId, status }: { orderId: string; status: string }) =>
      api.patch(`/orders/${orderId}/status`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      queryClient.invalidateQueries({ queryKey: ['summary'] });
    },
  });

  const productMutation = useMutation({
    mutationFn: async () => {
      const { name, description, price, category, attributes } = productForm;
      const payload = {
        name,
        description,
        price: Number(price),
        category,
        attributes,
        tags: productForm.tags_raw.split(',').map(t => t.trim()).filter(Boolean),
      };

      if (editingProductId) {
        await api.patch(`/product/${editingProductId}`, payload);
      } else {
        await api.post('/product', payload);
      }
    },
    onSuccess: () => {
      setProductForm(emptyProductForm);
      setEditingProductId(null);
      queryClient.invalidateQueries({ queryKey: ['products-admin'] });
      queryClient.invalidateQueries({ queryKey: ['summary'] });
    },
    onError: (error: any) => {
      alert(`Error saving product: ${error.response?.data?.message || error.message}`);
    },
  });

  const deleteProductMutation = useMutation({
    mutationFn: async (id: string) => api.delete(`/product/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products-admin'] });
      queryClient.invalidateQueries({ queryKey: ['summary'] });
    },
  });

  const updateTenantMutation = useMutation({
    mutationFn: async (tenant: Partial<Tenant>) => {
      const { id, ...data } = tenant;
      await api.patch(`/tenants/${id}`, data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['all-tenants'] });
      queryClient.invalidateQueries({ queryKey: ['current-tenant'] });
      setEditingTenant(null);
      showToast('Settings saved successfully!');
    },
    onError: (error: any) => {
      showToast(`Error saving settings: ${error.response?.data?.message || error.message}`, 'error');
    },
  });

  if (!token) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4 py-12">
        <section className="w-full max-w-5xl overflow-hidden rounded-[2rem] bg-white shadow-panel md:grid md:grid-cols-[1.2fr_0.8fr]">
          <div className="bg-ink px-8 py-10 text-white md:px-12 md:py-14">
            <p className="text-sm uppercase tracking-[0.3em] text-red-200">Global Ops Platform</p>
            <h1 className="mt-6 max-w-md font-display text-5xl leading-tight">
              Generic Multi-Tenant Infrastructure.
            </h1>
            <p className="mt-6 max-w-md text-base text-white/75">
              Support any business structure—from gourmet restaurants to luxury apparel—all within a unified WhatsApp automation core.
            </p>
          </div>
          <div className="px-8 py-10 md:px-10 md:py-14">
            <h2 className="font-display text-3xl text-ink">Admin Login</h2>
            <form
              className="mt-8 space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                loginMutation.mutate();
              }}
            >
              <label className="block">
                <span className="mb-2 block text-sm text-slate-600">Email</span>
                <input
                  className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-ember"
                  type="email"
                  value={credentials.email}
                  onChange={(event) =>
                    setCredentials((current) => ({ ...current, email: event.target.value }))
                  }
                />
              </label>
              <label className="block">
                <span className="mb-2 block text-sm text-slate-600">Password</span>
                <input
                  className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none transition focus:border-ember"
                  type="password"
                  value={credentials.password}
                  onChange={(event) =>
                    setCredentials((current) => ({ ...current, password: event.target.value }))
                  }
                />
              </label>
              <button
                className="w-full rounded-2xl bg-ember px-4 py-3 font-medium text-white transition hover:bg-red-600"
                type="submit"
                disabled={loginMutation.isPending}
              >
                {loginMutation.isPending ? 'Signing in...' : 'Sign in'}
              </button>
              {loginMutation.isError ? (
                <p className="text-sm text-red-600">Login failed. Check your credentials.</p>
              ) : null}
            </form>
          </div>
        </section>
      </main>
    );
  }

  if (currentUser?.role === 'SUPER_ADMIN') {
    return (
      <main className="min-h-screen px-4 py-6 md:px-8">
        <div className="mx-auto max-w-7xl">
          <header className="rounded-[2rem] bg-indigo-950 px-6 py-8 text-white shadow-panel md:px-8">
            <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
              <div>
                <p className="text-sm uppercase tracking-[0.3em] text-indigo-200">System Control</p>
                <h1 className="mt-4 font-display text-4xl">Super Admin Dashboard</h1>
                <p className="mt-3 max-w-2xl text-white/70">Design the core data structure for every tenant in the network.</p>
              </div>
              <button
                className="rounded-full border border-white/20 px-5 py-3 text-sm text-white/80 transition hover:bg-white/10"
                onClick={() => {
                  window.localStorage.clear();
                  window.location.reload();
                }}
              >
                Logout
              </button>
            </div>
          </header>

          <section className="mt-6 grid gap-6">
            <article className="rounded-[2rem] bg-white p-6 shadow-panel">
              <h2 className="font-display text-3xl text-ink">Active Tenants</h2>
              <div className="mt-6 space-y-4">
                {allTenantsQuery.data?.map(tenant => (
                  <div key={tenant.id} className="rounded-3xl border border-slate-100 p-6 flex flex-col gap-4">
                    <div className="flex justify-between items-start">
                      <div>
                        <h3 className="font-display text-xl">{tenant.name}</h3>
                        <p className="text-sm text-slate-500">ID: {tenant.id} | {tenant._count?.products} Products</p>
                      </div>
                      <div className="flex gap-2">
                         <button 
                          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-sm transition-colors" 
                          onClick={() => setEditingTenant(tenant)}
                        >
                           Manage Settings
                         </button>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="text-xs space-y-1">
                        <p className="font-semibold text-slate-400 uppercase tracking-wider">WhatsApp Status</p>
                        <p className={tenant.whatsappAccessToken ? 'text-green-600' : 'text-amber-600'}>
                          {tenant.whatsappAccessToken ? '✓ Connected' : '⚠ Missing Credentials'}
                        </p>
                      </div>
                      <div className="text-xs space-y-1">
                        <p className="font-semibold text-slate-400 uppercase tracking-wider">Payment Status</p>
                        <p className={tenant.razorpayKeyId ? 'text-indigo-600' : 'text-slate-400'}>
                          {tenant.razorpayKeyId ? '✓ Razorpay Enabled' : 'Cash on Delivery'}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </article>
          </section>

          {/* Tenant Settings Modal */}
          {editingTenant && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-indigo-950/40 backdrop-blur-sm p-4">
              <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-white rounded-[2.5rem] shadow-2xl p-8 scrollbar-hide">
                <div className="flex justify-between items-start mb-8">
                  <div>
                    <h2 className="font-display text-3xl text-ink">Manage {editingTenant.name}</h2>
                    <p className="text-sm text-slate-500 mt-1">Configure automation and payment infrastructure.</p>
                  </div>
                  <button 
                    onClick={() => setEditingTenant(null)}
                    className="p-2 hover:bg-slate-100 rounded-full transition-colors"
                  >
                    ×
                  </button>
                </div>

                <form className="space-y-8" onSubmit={(e) => {
                  e.preventDefault();
                  const formData = new FormData(e.currentTarget);
                  const updates: any = {
                    id: editingTenant.id,
                    name: formData.get('name'),
                    businessType: formData.get('businessType'),
                    whatsappVerifyToken: formData.get('whatsappVerifyToken'),
                    whatsappPhoneNumberId: formData.get('whatsappPhoneNumberId'),
                    whatsappAccessToken: formData.get('whatsappAccessToken'),
                    whatsappApiVersion: formData.get('whatsappApiVersion'),
                    razorpayKeyId: formData.get('razorpayKeyId'),
                    razorpayKeySecret: formData.get('razorpayKeySecret'),
                    timezone: formData.get('timezone'),
                    categories: (formData.get('categories_raw') as string)?.split(',').map(s => s.trim()).filter(Boolean) || [],
                  };
                  
                  updates.productSchema = localSchema;

                  updateTenantMutation.mutate(updates);
                }}>
                  <div className="space-y-6">
                    <div className="p-6 bg-slate-50 rounded-3xl space-y-4">
                      <h3 className="text-sm font-bold uppercase tracking-widest text-slate-400">Basic Information</h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <label className="block">
                          <span className="text-xs font-medium text-slate-600 mb-1 block">Business Name</span>
                          <input 
                            name="name"
                            defaultValue={editingTenant.name} 
                            placeholder="e.g. Gourmet Bistro"
                            className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:border-indigo-500"
                          />
                        </label>
                        <label className="block">
                          <span className="text-xs font-medium text-slate-600 mb-1 block">Business Type</span>
                          <input 
                            name="businessType"
                            defaultValue={editingTenant.businessType || ''} 
                            placeholder="e.g. RESTAURANT"
                            className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:border-indigo-500"
                          />
                        </label>
                      </div>
                    </div>

                    <div className="p-6 bg-slate-50 rounded-3xl space-y-4">
                      <h3 className="text-sm font-bold uppercase tracking-widest text-slate-400">WhatsApp Credentials</h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <label className="block">
                          <span className="text-xs font-medium text-slate-600 mb-1 block">Verify Token</span>
                          <input 
                            name="whatsappVerifyToken"
                            defaultValue={editingTenant.whatsappVerifyToken} 
                            placeholder="e.g. my_secret_verify_token"
                            className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:border-indigo-500"
                          />
                        </label>
                        <label className="block">
                          <span className="text-xs font-medium text-slate-600 mb-1 block">Phone Number ID</span>
                          <input 
                            name="whatsappPhoneNumberId"
                            defaultValue={editingTenant.whatsappPhoneNumberId} 
                            placeholder="e.g. 10741392..."
                            className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:border-indigo-500"
                          />
                        </label>
                        <label className="block col-span-full">
                          <span className="text-xs font-medium text-slate-600 mb-1 block">Access Token</span>
                          <textarea 
                            name="whatsappAccessToken"
                            defaultValue={editingTenant.whatsappAccessToken} 
                            rows={3}
                            placeholder="Long-lived page access token..."
                            className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:border-indigo-500 resize-none font-mono"
                          />
                        </label>
                        <label className="block">
                          <span className="text-xs font-medium text-slate-600 mb-1 block">API Version</span>
                          <input 
                            name="whatsappApiVersion"
                            defaultValue={editingTenant.whatsappApiVersion || 'v20.0'} 
                            placeholder="v20.0"
                            className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:border-indigo-500"
                          />
                        </label>
                      </div>
                    </div>

                    <div className="p-6 bg-slate-50 rounded-3xl space-y-4">
                      <h3 className="text-sm font-bold uppercase tracking-widest text-slate-400">Menu Categories</h3>
                      <label className="block">
                        <span className="text-xs font-medium text-slate-600 mb-1 block">Categories (comma-separated)</span>
                        <input 
                          name="categories_raw"
                          defaultValue={editingTenant.categories?.join(', ') || ''} 
                          placeholder="e.g. Starters, Main Course, Drinks"
                          className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:border-indigo-500"
                        />
                      </label>
                    </div>

                    <div className="p-6 bg-slate-50 rounded-3xl space-y-4">
                      <h3 className="text-sm font-bold uppercase tracking-widest text-slate-400">Razorpay Configuration</h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <label className="block">
                          <span className="text-xs font-medium text-slate-600 mb-1 block">Key ID</span>
                          <input 
                            name="razorpayKeyId"
                            defaultValue={editingTenant.razorpayKeyId} 
                            placeholder="rzp_test_..."
                            className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:border-indigo-500"
                          />
                        </label>
                        <label className="block">
                          <span className="text-xs font-medium text-slate-600 mb-1 block">Key Secret</span>
                          <input 
                            name="razorpayKeySecret"
                            defaultValue={editingTenant.razorpayKeySecret} 
                            type="password"
                            placeholder="••••••••"
                            className="w-full px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm outline-none focus:border-indigo-500"
                          />
                        </label>
                      </div>
                    </div>

                    <div className="p-6 bg-slate-50 rounded-3xl space-y-4">
                      <div className="flex justify-between items-center">
                        <h3 className="text-sm font-bold uppercase tracking-widest text-slate-400">Product Custom Fields</h3>
                        <button 
                          type="button"
                          onClick={addField}
                          className="px-4 py-2 bg-indigo-100 text-indigo-700 rounded-xl text-xs font-bold hover:bg-indigo-200 transition-colors"
                        >
                          + Add Field
                        </button>
                      </div>

                      <div className="space-y-4">
                        {localSchema.map((item, index) => (
                          <div key={index} className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm relative group">
                            <button 
                              type="button" 
                              onClick={() => removeField(index)}
                              className="absolute -top-2 -right-2 bg-red-100 text-red-600 rounded-full w-6 h-6 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow-sm z-10"
                            >
                              ×
                            </button>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
                              <label>
                                <span className="text-[10px] font-bold text-slate-400 uppercase ml-1">Label (e.g. Size)</span>
                                <input 
                                  value={item.label || ''} 
                                  onChange={e => {
                                    const newLabel = e.target.value;
                                    const updates: Partial<ProductSchemaItem> = { label: newLabel };
                                    if (!item.name || item.name.startsWith('field_')) {
                                      updates.name = newLabel.toLowerCase().replace(/\s+/g, '_');
                                    }
                                    updateField(index, updates);
                                  }}
                                  className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-indigo-400"
                                />
                              </label>
                              <label>
                                <span className="text-[10px] font-bold text-slate-400 uppercase ml-1">Type</span>
                                <select 
                                  value={item.type} 
                                  onChange={e => updateField(index, { type: e.target.value as any })}
                                  className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-indigo-400"
                                >
                                  <option value="text">Short Text</option>
                                  <option value="string">Long Text</option>
                                  <option value="number">Number</option>
                                  <option value="boolean">Checkbox / Toggle</option>
                                  <option value="select">Dropdown / Options</option>
                                </select>
                              </label>
                              <label>
                                <span className="text-[10px] font-bold text-slate-400 uppercase ml-1">Icon (Emoji/Short Text)</span>
                                <input 
                                  value={item.icon || ''} 
                                  placeholder="e.g. 🥦, 🌶️"
                                  onChange={e => updateField(index, { icon: e.target.value })}
                                  className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-indigo-400"
                                />
                              </label>
                            </div>

                            <div className="mb-3">
                               <span className="text-[10px] font-bold text-slate-400 uppercase ml-1">Applies to Categories (Empty = All)</span>
                               <div className="flex flex-wrap gap-2 mt-1">
                                  {editingTenant.categories?.map(cat => (
                                    <button
                                      key={cat}
                                      type="button"
                                      onClick={() => {
                                        const current = item.appliesTo || [];
                                        const next = current.includes(cat) 
                                          ? current.filter(c => c !== cat)
                                          : [...current, cat];
                                        updateField(index, { appliesTo: next });
                                      }}
                                      className={`px-3 py-1 rounded-full text-[10px] font-bold transition-all ${
                                        item.appliesTo?.includes(cat)
                                          ? 'bg-indigo-600 text-white'
                                          : 'bg-slate-100 text-slate-400 hover:bg-slate-200'
                                      }`}
                                    >
                                      {cat}
                                    </button>
                                  ))}
                                  {(editingTenant.categories?.length || 0) === 0 && (
                                    <p className="text-[10px] text-slate-400 italic">No categories defined yet.</p>
                                  )}
                               </div>
                            </div>
                            
                            
                            { (item.type === 'select' || item.type === 'number') && (
                              <label className="block mb-3">
                                <span className="text-[10px] font-bold text-slate-400 uppercase ml-1">
                                  {item.type === 'number' ? 'Value Labels (0, 1, 2, 3... comma separated)' : 'Options (comma-separated)'}
                                </span>
                                <input 
                                  value={item.options?.join(', ') || ''} 
                                  onChange={e => updateField(index, { options: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                                  placeholder="e.g. Small, Medium, Large"
                                  className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm outline-none focus:border-indigo-400"
                                />
                              </label>
                            )}

                            <label className="flex items-center gap-2 cursor-pointer">
                              <input 
                                type="checkbox" 
                                checked={!!item.required} 
                                onChange={e => updateField(index, { required: e.target.checked })}
                                className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                              />
                              <span className="text-xs font-semibold text-slate-600">Mark as Required</span>
                            </label>
                          </div>
                        ))}
                        
                        {localSchema.length === 0 && (
                          <div className="text-center py-8 border-2 border-dashed border-slate-200 rounded-3xl">
                            <p className="text-sm text-slate-400">No custom fields defined yet.</p>
                            <p className="text-xs text-slate-300 mt-1">Tenant will only see default name, description, and price.</p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-3 pt-4">
                    <button 
                      type="submit" 
                      disabled={updateTenantMutation.isPending}
                      className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-3 rounded-2xl transition-colors disabled:opacity-50"
                    >
                      {updateTenantMutation.isPending ? 'Saving Configuration...' : 'Save Configuration'}
                    </button>
                    <button 
                      type="button"
                      onClick={() => setEditingTenant(null)}
                      className="px-6 py-3 border border-slate-200 text-slate-600 font-medium rounded-2xl hover:bg-slate-50 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </div>
      </main>
    );
  }

  const summary = summaryQuery.data;
  const currentTenantSchema = tenantQuery.data?.productSchema || [];

  return (
    <>
    <main className="min-h-screen px-4 py-6 md:px-8">
      <div className="mx-auto max-w-7xl">
        <header className="rounded-[2rem] bg-ink px-6 py-8 text-white shadow-panel md:px-8">
          <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.3em] text-red-200">{tenantQuery.data?.name || 'Loading...'}</p>
              <nav className="mt-4 flex gap-8 border-b border-white/10">
                 <button 
                  onClick={() => setActiveTab('dashboard')}
                  className={`pb-4 text-sm font-medium transition-colors ${activeTab === 'dashboard' ? 'text-white border-b-2 border-ember' : 'text-white/40 hover:text-white/60'}`}
                 >Dashboard</button>
                 <button 
                  onClick={() => setActiveTab('settings')}
                  className={`pb-4 text-sm font-medium transition-colors ${activeTab === 'settings' ? 'text-white border-b-2 border-ember' : 'text-white/40 hover:text-white/60'}`}
                 >Business Settings</button>
              </nav>
            </div>
            <button
              className="rounded-full border border-white/20 px-5 py-3 text-sm text-white/80 transition hover:bg-white/10"
              onClick={() => {
                window.localStorage.clear();
                window.location.reload();
              }}
            >
              Logout
            </button>
          </div>
        </header>

        {activeTab === 'dashboard' ? (
          <>
            <section className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
              {[
                ['Orders', summary?.ordersCount ?? 0],
                ['Pending', summary?.pendingOrdersCount ?? 0],
                ['Completed', summary?.completedOrdersCount ?? 0],
                ['Reviews', summary?.reviewsCount ?? 0],
                ['Products', summary?.productCount ?? 0],
              ].map(([label, value]) => (
                <article key={label} className="rounded-[1.5rem] bg-white p-5 shadow-panel">
                  <p className="text-sm text-slate-500">{label}</p>
                  <p className="mt-3 font-display text-4xl text-ink">{value}</p>
                </article>
              ))}
            </section>

            <section className="mt-6 grid gap-6 xl:grid-cols-[1.4fr_1fr]">
              <article className="rounded-[2rem] bg-white p-6 shadow-panel">
                {(alertsQuery.data?.length ?? 0) > 0 && (
                  <div className="mb-10 w-full">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-4">
                        <h2 className="font-display text-3xl text-red-500">Staff Action Required</h2>
                        <button 
                          onClick={() => setIsManualModalOpen(true)}
                          className="bg-indigo-600 text-white px-4 py-2 rounded-xl text-xs font-bold shadow-lg shadow-indigo-100 hover:bg-indigo-700 transition-all"
                        >
                          📦 Place Manual Order
                        </button>
                      </div>
                      <span className="bg-red-100 text-red-600 px-3 py-1 rounded-full text-xs font-bold">
                        {alertsQuery.data?.filter(a => !a.isDismissed).length} Pending
                      </span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="min-w-full text-left text-sm">
                        <thead className="text-slate-500">
                          <tr>
                            <th className="pb-3">Customer</th>
                            <th className="pb-3">Message / Action</th>
                            <th className="pb-3">Time</th>
                            <th className="pb-3 text-right">Status</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {alertsQuery.data?.map((alertItem) => (
                            <div key={alertItem.id} style={{ display: 'contents' }}>
                              <tr className={alertItem.isDismissed ? 'opacity-40' : 'bg-red-50/50'}>
                                <td className="py-4 px-4 font-medium text-ink">
                                  {alertItem.customerPhone}
                                </td>
                                <td className="py-4 pr-4">
                                  <span className="font-semibold text-slate-700">{alertItem.reason}</span>
                                </td>
                                <td className="py-4 pr-4 text-[10px] text-slate-400">
                                  {new Date(alertItem.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                  <div>{new Date(alertItem.createdAt).toLocaleDateString()}</div>
                                </td>
                                <td className="py-4 pr-4 text-right">
                                  {alertItem.isDismissed ? (
                                    <span className="text-xs text-slate-400 font-semibold">✅ Handled</span>
                                  ) : (
                                    <div className="flex items-center justify-end gap-2">
                                      <button
                                        className="text-xs bg-indigo-50 border border-indigo-100 px-4 py-2 rounded-xl text-indigo-600 font-bold hover:bg-indigo-100"
                                        onClick={() => {
                                          setReplyingTo(replyingTo === alertItem.id ? null : alertItem.id);
                                          setReplyMessage('');
                                        }}
                                      >
                                        {replyingTo === alertItem.id ? 'Cancel' : '💬 Reply'}
                                      </button>
                                      <button
                                        className="text-xs bg-white border border-slate-200 shadow-sm px-4 py-2 rounded-xl text-slate-600 font-bold hover:bg-slate-50 disabled:opacity-50"
                                        disabled={dismissAlertMutation.isPending}
                                        onClick={() => dismissAlertMutation.mutate(alertItem.id)}
                                      >
                                        Mark Handled ✅
                                      </button>
                                    </div>
                                  )}
                                </td>
                              </tr>
                              {replyingTo === alertItem.id && !alertItem.isDismissed && (
                                <tr className="bg-indigo-50/30">
                                  <td colSpan={4} className="p-4">
                                    <div className="flex gap-3 items-end">
                                      <div className="flex-1">
                                        <label className="block text-[10px] uppercase tracking-wider font-bold text-indigo-400 mb-1">
                                          Your Response to {alertItem.customerPhone}
                                        </label>
                                        <textarea
                                          className="w-full rounded-xl border border-indigo-100 p-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none shadow-sm"
                                          placeholder="Type your reply here..."
                                          rows={2}
                                          value={replyMessage}
                                          onChange={(e) => setReplyMessage(e.target.value)}
                                        />
                                      </div>
                                      <button
                                        className="bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold text-sm shadow-lg shadow-indigo-200 hover:bg-indigo-700 transition-all disabled:opacity-50"
                                        disabled={!replyMessage.trim() || replyMutation.isPending}
                                        onClick={() => replyMutation.mutate({ 
                                          customerPhone: alertItem.customerPhone, 
                                          message: replyMessage 
                                        })}
                                      >
                                        {replyMutation.isPending ? 'Sending...' : 'Send Message 🚀'}
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </div>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                <div>
                  <h2 className="font-display text-3xl text-ink">Orders</h2>
                  <p className="mt-2 text-sm text-slate-500">Update status to trigger customer notifications and review collection.</p>
                </div>
                {/* ... existing orders table ... */}
                <div className="mt-6 overflow-x-auto">
                  <table className="min-w-full text-left text-sm">
                    <thead className="text-slate-500">
                      <tr>
                        <th className="pb-3">Customer</th>
                        <th className="pb-3">Details</th>
                        <th className="pb-3">Amount</th>
                        <th className="pb-3">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {ordersQuery.data?.map((order) => (
                        <Fragment key={order.id}>
                          <tr className={`transition-all duration-500 rounded-2xl ${getOrderStatusStyles(order)}`}>
                            <td className="py-4 px-4 pr-4">
                              <div className="flex items-center gap-2">
                                <div className="font-medium text-ink">{order.customerPhone}</div>
                                {order.source === 'MANUAL' ? (
                                  <span className="text-[9px] bg-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded-md font-bold uppercase tracking-tighter">👤 Staff</span>
                                ) : (
                                  <span className="text-[9px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded-md font-bold uppercase tracking-tighter">🤖 Bot</span>
                                )}
                              </div>
                              <div className="text-[10px] font-mono font-bold tracking-tighter text-indigo-500 bg-indigo-50 px-1.5 py-0.5 rounded-md inline-block mt-1">
                                {maskId(order.id)}
                              </div>
                            </td>
                            <td className="py-4 pr-4">
                              <div className="text-xs font-semibold text-slate-700">
                                {order.orderItems.map((item) => item.product.name).join(', ')}
                              </div>
                              <div className="text-[10px] text-slate-400 mt-1">
                                {new Date(order.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </div>
                            </td>
                            <td className="py-4 pr-4 font-display text-ink font-bold">{formatPrice(order.totalAmount)}</td>
                            <td className="py-4 pr-4">
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  className={`text-[10px] font-bold px-3 py-1.5 rounded-lg transition-all ${
                                    replyingTo === order.id 
                                      ? 'bg-ink text-white' 
                                      : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
                                  }`}
                                  onClick={() => {
                                    setReplyingTo(replyingTo === order.id ? null : order.id);
                                    setReplyMessage('');
                                  }}
                                >
                                  {replyingTo === order.id ? 'Close Chat' : '💬 Chat'}
                                </button>
                                <select
                                  className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold bg-white"
                                  value={order.status}
                                  onChange={(event) =>
                                    statusMutation.mutate({ orderId: order.id, status: event.target.value })
                                  }
                                >
                                  {statusOptions.map((status) => (
                                    <option key={status} value={status}>{status}</option>
                                  ))}
                                </select>
                              </div>
                            </td>
                          </tr>
                          {replyingTo === order.id && (
                            <tr className="bg-indigo-50/30">
                              <td colSpan={4} className="p-4">
                                <div className="flex gap-3 items-end">
                                  <div className="flex-1">
                                    <label className="block text-[10px] uppercase tracking-wider font-bold text-indigo-400 mb-1">
                                      Chat with {order.customerPhone} (Order {maskId(order.id)})
                                    </label>
                                    <textarea
                                      className="w-full rounded-xl border border-indigo-100 p-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none shadow-sm"
                                      placeholder="Type your message here..."
                                      rows={2}
                                      value={replyMessage}
                                      onChange={(e) => setReplyMessage(e.target.value)}
                                    />
                                  </div>
                                  <button
                                    className="bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold text-sm shadow-lg shadow-indigo-200 hover:bg-indigo-700 transition-all disabled:opacity-50"
                                    disabled={!replyMessage.trim() || replyMutation.isPending}
                                    onClick={() => replyMutation.mutate({ 
                                      customerPhone: order.customerPhone, 
                                      message: replyMessage 
                                    })}
                                  >
                                    {replyMutation.isPending ? 'Sending...' : 'Send Message 🚀'}
                                  </button>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>

              <article className="rounded-[2rem] bg-white p-6 shadow-panel">
                {/* ... existing products list/form ... */}
                <div>
                  <h2 className="font-display text-3xl text-ink">Products</h2>
                  <p className="mt-2 text-sm text-slate-500">Add or edit items using your specific business schema.</p>
                </div>
                <form
                  className="mt-6 grid gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    productMutation.mutate();
                  }}
                >
                  <input
                    className="rounded-2xl border border-slate-200 px-4 py-3 shadow-sm outline-none focus:border-ember"
                    placeholder="Product name"
                    value={productForm.name}
                    onChange={(event) => setProductForm((current) => ({ ...current, name: event.target.value }))}
                    required
                  />
                  <textarea
                    className="min-h-24 rounded-2xl border border-slate-200 px-4 py-3 shadow-sm outline-none focus:border-ember"
                    placeholder="Description"
                    value={productForm.description}
                    onChange={(event) => setProductForm((current) => ({ ...current, description: event.target.value }))}
                    required
                  />
                  <input
                    className="rounded-2xl border border-slate-200 px-4 py-3 shadow-sm outline-none focus:border-ember"
                    placeholder="Price"
                    value={productForm.price}
                    onChange={(event) => setProductForm((current) => ({ ...current, price: event.target.value }))}
                    required
                  />

                  <select
                    className="rounded-2xl border border-slate-200 px-4 py-3 shadow-sm outline-none focus:border-ember bg-white"
                    value={productForm.category}
                    onChange={(e) => setProductForm(c => ({ ...c, category: e.target.value }))}
                    required
                  >
                    <option value="General">Select Category</option>
                    {tenantQuery.data?.categories?.map(cat => (
                      <option key={cat} value={cat}>{cat}</option>
                    ))}
                  </select>

                  <div className="space-y-2">
                    <p className="text-xs text-slate-500 mb-1 ml-2">Product Image</p>
                    <div className="flex items-center gap-4">
                      {productForm.imageUrl && (
                        <img 
                          src={productForm.imageUrl.startsWith('http') ? productForm.imageUrl : `${api.defaults.baseURL}${productForm.imageUrl}`} 
                          alt="Preview" 
                          className="w-16 h-16 rounded-xl object-cover border border-slate-200"
                        />
                      )}
                      <label className="flex-1 flex flex-col items-center justify-center h-16 px-4 border-2 border-dashed border-slate-200 rounded-xl cursor-pointer hover:border-indigo-400 transition-colors">
                        <span className="text-xs font-medium text-slate-500">
                          {productForm.imageUrl ? 'Change Image' : 'Upload Image'}
                        </span>
                        <input 
                          type="file" 
                          accept="image/*" 
                          className="hidden" 
                          onChange={async (e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            
                            const formData = new FormData();
                            formData.append('file', file);
                            
                            try {
                              const res = await api.post('/upload', formData, {
                                headers: { 'Content-Type': 'multipart/form-data' }
                              });
                              setProductForm(c => ({ ...c, imageUrl: res.data.url }));
                            } catch (error: any) {
                              alert('Upload failed: ' + (error.response?.data?.message || error.message));
                            }
                          }}
                        />
                      </label>
                    </div>
                  </div>

                  <input
                    className="rounded-2xl border border-slate-200 px-4 py-3 shadow-sm outline-none focus:border-ember"
                    placeholder="Tags (best seller, new, etc. - comma separated)"
                    value={productForm.tags_raw}
                    onChange={(e) => setProductForm(c => ({ ...c, tags_raw: e.target.value }))}
                  />

                  {currentTenantSchema.filter(field => {
                    // Filter based on selected category
                    if (!field.appliesTo || field.appliesTo.length === 0) return true;
                    return field.appliesTo.includes(productForm.category);
                  }).map((field) => {
                    const fieldKey = (field.name || field.id) as string;
                    return (
                      <div key={fieldKey}>
                        <p className="text-xs text-slate-500 mb-1 ml-2">
                          {field.label || field.name || field.id} {field.required ? '*' : ''}
                        </p>
                        {field.type === 'select' ? (
                          <select
                            className="w-full rounded-2xl border border-slate-200 px-4 py-3 shadow-sm outline-none focus:border-ember"
                            value={productForm.attributes[fieldKey] || ''}
                            onChange={(e) => setProductForm(c => ({ ...c, attributes: { ...c.attributes, [fieldKey]: e.target.value } }))}
                            required={field.required}
                          >
                            <option value="">Select {field.label || field.name || field.id}</option>
                            {field.options?.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                          </select>
                        ) : field.type === 'boolean' ? (
                          <label className="flex items-center gap-2 p-3 rounded-2xl border border-slate-100 bg-slate-50/50">
                            <input 
                              type="checkbox"
                              className="h-5 w-5 rounded border-slate-300 text-ember focus:ring-ember"
                              checked={!!productForm.attributes[fieldKey]}
                              onChange={(e) => setProductForm(c => ({ ...c, attributes: { ...c.attributes, [fieldKey]: e.target.checked } }))}
                            />
                            <span className="text-sm font-medium text-slate-700">{field.label || field.name || field.id}</span>
                          </label>
                        ) : (field.type === 'number' && field.options && field.options.length > 0) ? (
                          <div className="flex flex-wrap gap-2 mt-1">
                            {field.options.map((label, i) => (
                              <button
                                key={label}
                                type="button"
                                onClick={() => setProductForm(c => ({ ...c, attributes: { ...c.attributes, [fieldKey]: i } }))}
                                className={`px-4 py-2 rounded-xl text-xs font-bold transition-all border ${
                                  (productForm.attributes[fieldKey] ?? 0) === i
                                    ? 'bg-ember border-ember text-white shadow-md'
                                    : 'bg-white border-slate-200 text-slate-500 hover:border-indigo-400'
                                }`}
                              >
                                <span className="block opacity-60 text-[8px] uppercase">{i}</span>
                                {label}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <input
                            type={field.type === 'number' ? 'number' : 'text'}
                            className="w-full rounded-2xl border border-slate-200 px-4 py-3 shadow-sm outline-none focus:border-ember"
                            placeholder={field.label || field.name || field.id}
                            value={productForm.attributes[fieldKey] ?? ''}
                            onChange={(e) => {
                              const val = e.target.value;
                              const finalVal = field.type === 'number' ? (val === '' ? undefined : Number(val)) : val;
                              setProductForm(c => ({ ...c, attributes: { ...c.attributes, [fieldKey]: finalVal } }));
                            }}
                            required={field.required}
                          />
                        )}
                      </div>
                    );
                  })}

                  <button className="rounded-2xl bg-ink px-4 py-4 font-medium text-white transition hover:bg-slate-800" type="submit" disabled={productMutation.isPending}>
                    {editingProductId ? 'Update item' : 'Add item to catalog'}
                  </button>
                </form>

                <div className="mt-6 space-y-3">
                  {productQuery.data?.map((p) => (
                    <div key={p.id} className="rounded-[1.5rem] border border-slate-100 p-4 hover:bg-slate-50 transition">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="font-medium text-ink">{p.name}</p>
                          <p className="mt-1 text-sm text-slate-500 italic">{formatPrice(p.price)}</p>
                        </div>
                        <div className="flex gap-2">
                          <button
                            className="rounded-full border border-slate-200 px-3 py-2 text-xs"
                            onClick={() => {
                              setEditingProductId(p.id);
                              setProductForm({
                                name: p.name,
                                description: p.description,
                                price: p.price,
                                isAvailable: p.isAvailable,
                                attributes: p.attributes || {},
                                category: p.category || 'General',
                                imageUrl: p.imageUrl || '',
                                tags_raw: p.tags?.join(', ') || '',
                              });
                            }}
                          >Edit</button>
                          <button
                            className="rounded-full border border-red-200 px-3 py-2 text-xs text-red-600 font-medium hover:bg-red-50 transition-colors"
                            onClick={() => {
                              if (confirm('Are you sure you want to delete this product?')) {
                                deleteProductMutation.mutate(p.id);
                              }
                            }}
                          >Delete</button>
                        </div>
                      </div>
                      <div className="flex gap-2 mt-2">
                        <span className="text-[10px] font-bold px-2 py-0.5 bg-slate-100 text-slate-500 rounded-md">
                          {p.category}
                        </span>
                        {p.tags?.map(tag => (
                          <span key={tag} className="text-[10px] font-bold px-2 py-0.5 bg-indigo-50 text-indigo-500 rounded-md">
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </article>
            </section>
          </>
        ) : (
          <section className="mt-6 grid gap-6 lg:grid-cols-2">
             <article className="rounded-[2rem] bg-white p-8 shadow-panel col-span-full">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="font-display text-3xl text-ink">AI Ordering Assistant</h2>
                    <p className="text-sm text-slate-500 mt-1">When disabled, all messages are flagged for manual response. No automated replies will be sent.</p>
                  </div>
                  <div className="flex items-center gap-4">
                     <span className={`text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-full ${
                       tenantQuery.data?.isBotEnabled 
                        ? 'bg-indigo-100 text-indigo-700' 
                        : 'bg-slate-100 text-slate-500'
                     }`}>
                       {tenantQuery.data?.isBotEnabled ? 'Bot Active 🤖' : 'Manual Only 👤'}
                     </span>
                     <button 
                       onClick={() => updateTenantMutation.mutate({ 
                         id: tenantQuery.data?.id, 
                         isBotEnabled: !tenantQuery.data?.isBotEnabled 
                       })}
                       className={`relative inline-flex h-9 w-16 items-center rounded-full transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 ${
                         tenantQuery.data?.isBotEnabled ? 'bg-indigo-600 shadow-lg shadow-indigo-200' : 'bg-slate-200'
                       }`}
                     >
                       <span className={`inline-block h-7 w-7 transform rounded-full bg-white transition-transform duration-300 shadow-md ${
                         tenantQuery.data?.isBotEnabled ? 'translate-x-8' : 'translate-x-1'
                       }`} />
                     </button>
                  </div>
                </div>
             </article>

             <article className="rounded-[2rem] bg-white p-8 shadow-panel">
                <h2 className="font-display text-3xl text-ink mb-6">Business Operations</h2>
                <form className="space-y-6" onSubmit={(e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  updateTenantMutation.mutate({
                    id: tenantQuery.data?.id,
                    openTime: fd.get('openTime') as string,
                    closeTime: fd.get('closeTime') as string,
                    timezone: fd.get('timezone') as string,
                  });
                }}>
                   <div className="grid grid-cols-2 gap-4">
                      <label className="block">
                        <span className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2 block">Opening Time</span>
                        <input name="openTime" type="time" defaultValue={tenantQuery.data?.openTime} className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none focus:border-ember" />
                      </label>
                      <label className="block">
                        <span className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2 block">Closing Time</span>
                        <input name="closeTime" type="time" defaultValue={tenantQuery.data?.closeTime} className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none focus:border-ember" />
                      </label>
                   </div>
                   <label className="block">
                      <span className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2 block">Timezone</span>
                      <input name="timezone" defaultValue={tenantQuery.data?.timezone || 'Asia/Kolkata'} className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none focus:border-ember" />
                   </label>
                   <button className="w-full rounded-2xl bg-ink py-4 font-medium text-white transition hover:bg-slate-800" type="submit">
                      Save Operations
                   </button>
                </form>
             </article>

             <article className="rounded-[2rem] bg-white p-8 shadow-panel">
                <h2 className="font-display text-3xl text-ink mb-2">WhatsApp Templates</h2>
                <p className="text-sm text-slate-500 mb-6 font-medium italic">Available placeholders: {"{{id}}, {{status}}, {{total}}, {{items}}"}</p>
                <form className="space-y-4" onSubmit={(e) => {
                   e.preventDefault();
                   const fd = new FormData(e.currentTarget);
                   const templates: any = {};
                   ['HELP_TEXT', 'MENU_HEADER', 'ORDER_PAYMENT_PROMPT', 'ORDER_STATUS', 'BUSINESS_CLOSED'].forEach(key => {
                      templates[key] = fd.get(key);
                   });
                   updateTenantMutation.mutate({
                      id: tenantQuery.data?.id,
                      messageTemplates: templates
                   });
                }}>
                   {[
                     ['HELP_TEXT', 'Help/Commands Message'],
                     ['MENU_HEADER', 'Menu Catalog Header'],
                     ['ORDER_PAYMENT_PROMPT', 'Payment Method Inquiry'],
                     ['ORDER_STATUS', 'Order Status Update'],
                     ['BUSINESS_CLOSED', 'Closed Auto-Reply'],
                   ].map(([id, label]) => (
                      <label key={id} className="block">
                         <span className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2 block">{label}</span>
                         <textarea 
                          name={id}
                          rows={2}
                          defaultValue={(tenantQuery.data?.messageTemplates as any)?.[id] || ''} 
                          className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none focus:border-ember text-sm font-mono"
                         />
                      </label>
                   ))}
                   <button className="w-full rounded-2xl bg-ink py-4 font-medium text-white transition hover:bg-slate-800" type="submit">
                      Update Templates
                   </button>
                </form>
             </article>
              <article className="rounded-[2rem] bg-white p-8 shadow-panel col-span-full">
                 <h2 className="font-display text-3xl text-ink mb-6">Menu Categories</h2>
                 <form className="space-y-4" onSubmit={(e) => {
                    e.preventDefault();
                    const fd = new FormData(e.currentTarget);
                    const cats = (fd.get('categories_raw') as string)
                        .split(',')
                        .map(s => s.trim())
                        .filter(Boolean);
                    
                    updateTenantMutation.mutate({
                        id: tenantQuery.data?.id,
                        categories: cats,
                    });
                 }}>
                    <label className="block">
                      <span className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-2 block">Categories (comma-separated)</span>
                      <textarea 
                        name="categories_raw"
                        defaultValue={tenantQuery.data?.categories?.join(', ') || ''} 
                        placeholder="e.g. Starters, Main Course, Drinks, Desserts"
                        className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none focus:border-ember min-h-24"
                      />
                    </label>
                    <button className="w-full rounded-2xl bg-ink py-4 font-medium text-white transition hover:bg-slate-800" type="submit">
                       Update Menu Categories
                    </button>
                 </form>
              </article>
           </section>
        )}

        <section className="mt-6 rounded-[2rem] bg-white p-6 shadow-panel">
          <h2 className="font-display text-3xl text-ink">Reviews</h2>
          <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {reviewsQuery.data?.map((review) => (
              <article key={review.id} className="rounded-[1.5rem] border border-slate-100 p-4">
                <div className="flex items-center justify-between">
                  <p className="font-medium text-ink">{review.product.name}</p>
                  <span className="rounded-full bg-orange-50 px-3 py-1 text-sm text-ember">{review.rating}/5</span>
                </div>
                <p className="mt-3 text-sm text-slate-600">{review.comment}</p>
                <p className="mt-4 text-xs text-slate-400">
                  {review.order.customerPhone} | {new Date(review.createdAt).toLocaleDateString()}
                </p>
              </article>
            ))}
          </div>
        </section>

      {/* Manual Order Modal */}
      {isManualModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg bg-white rounded-[2.5rem] p-8 shadow-2xl animate-in fade-in zoom-in duration-300">
            <div className="flex justify-between items-center mb-6">
              <h2 className="font-display text-2xl text-ink">Manual Order Placement</h2>
              <button 
                onClick={() => setIsManualModalOpen(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase ml-1 mb-1">Customer Phone Number</label>
                <input 
                  className="w-full rounded-2xl border border-slate-200 px-4 py-3 outline-none focus:border-indigo-600"
                  placeholder="e.g. 919876543210"
                  value={manualPhone}
                  onChange={e => setManualPhone(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-[10px] font-bold text-slate-400 uppercase ml-1 mb-1">Select Products</label>
                <div className="max-h-56 overflow-y-auto border border-slate-100 rounded-2xl p-2 space-y-2">
                  {productsQuery.data?.filter(p => p.isAvailable).map(product => {
                    const existing = manualItems.find(i => i.productId === product.id);
                    return (
                      <div key={product.id} className="flex items-center justify-between p-2 rounded-xl border border-slate-50 bg-slate-50/30">
                        <span className="text-sm font-medium">{product.name} ({formatPrice(product.price)})</span>
                        <div className="flex items-center gap-2">
                           {existing ? (
                             <>
                               <button 
                                 onClick={() => {
                                   if (existing.quantity > 1) {
                                     setManualItems(curr => curr.map(i => i.productId === product.id ? {...i, quantity: i.quantity - 1} : i));
                                   } else {
                                     setManualItems(curr => curr.filter(i => i.productId !== product.id));
                                   }
                                 }}
                                 className="w-8 h-8 flex items-center justify-center rounded-lg bg-white border border-slate-200 text-slate-600"
                               >-</button>
                               <span className="text-sm font-bold w-4 text-center">{existing.quantity}</span>
                               <button 
                                 onClick={() => {
                                   if (existing.quantity < 10) {
                                     setManualItems(curr => curr.map(i => i.productId === product.id ? {...i, quantity: i.quantity + 1} : i));
                                   }
                                 }}
                                 className="w-8 h-8 flex items-center justify-center rounded-lg bg-white border border-slate-200 text-slate-600"
                               >+</button>
                             </>
                           ) : (
                             <button 
                               onClick={() => setManualItems(curr => [...curr, { productId: product.id, quantity: 1 }])}
                               className="text-[10px] font-bold text-indigo-600 border border-indigo-100 bg-white px-3 py-1.5 rounded-lg"
                             >
                               ADD TO ORDER
                             </button>
                           )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="pt-4 border-t border-slate-100">
                <div className="flex justify-between items-center mb-4 text-lg font-display font-bold">
                  <span>Estimated Total (Incl. Tax)</span>
                  <span>
                    {formatPrice(manualItems.reduce((acc, item) => {
                      const p = productsQuery.data?.find(pr => pr.id === item.productId);
                      return acc + (Number(p?.price || 0) * item.quantity);
                    }, 0) * 1.05)}
                  </span>
                </div>

                <button 
                  className="w-full bg-ink text-white py-4 rounded-2xl font-bold text-sm shadow-xl hover:bg-slate-800 transition-all disabled:opacity-50"
                  disabled={!manualPhone || manualItems.length === 0 || manualOrderMutation.isPending}
                  onClick={() => manualOrderMutation.mutate({ customerPhone: manualPhone, items: manualItems })}
                >
                  {manualOrderMutation.isPending ? 'Placing Order...' : 'Confirm & Place Order 🛒'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
        </div>
      </main>

      {/* Toast Notifications */}
      {toast && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[100] animate-in slide-in-from-bottom-4 duration-300">
          <div className={`px-6 py-3 rounded-2xl shadow-2xl font-bold text-sm tracking-wide flex items-center gap-2 border ${
            toast.type === 'success' 
             ? 'bg-ink text-white border-white/10' 
             : 'bg-red-600 text-white border-red-500'
          }`}>
            {toast.type === 'success' ? '✅' : '⚠️'}
            {toast.message}
          </div>
        </div>
      )}
    </>
  );
}
