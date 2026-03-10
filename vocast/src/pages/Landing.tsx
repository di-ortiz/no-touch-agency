import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Play, Sparkles, Calendar, Check } from 'lucide-react'

const features = [
  {
    icon: <Play size={24} />,
    title: 'One-Time Setup',
    description: 'Upload one photo, record your voice once. Our AI creates your digital avatar in minutes.',
  },
  {
    icon: <Sparkles size={24} />,
    title: 'AI-Written Scripts',
    description: 'Claude generates daily video scripts tailored to your industry and tone of voice.',
  },
  {
    icon: <Calendar size={24} />,
    title: 'Auto-Published Daily',
    description: 'Videos are automatically posted to LinkedIn, Instagram, and TikTok on your schedule.',
  },
]

const plans = [
  {
    name: 'Starter',
    price: '$297',
    period: '/mo',
    features: ['3 videos/week (12/month)', '2 platforms', 'Standard avatar quality', 'Email support'],
    popular: false,
  },
  {
    name: 'Growth',
    price: '$597',
    period: '/mo',
    features: ['Daily videos (30/month)', 'All 4 platforms', 'HD avatar quality', 'Priority support', 'Analytics dashboard'],
    popular: true,
  },
  {
    name: 'Enterprise',
    price: '$1,497',
    period: '/mo',
    features: ['Unlimited videos', 'All platforms + YouTube Shorts', 'Custom branded avatar', 'Dedicated account manager', 'White-glove onboarding'],
    popular: false,
  },
]

export default function Landing() {
  return (
    <div className="min-h-screen bg-background">
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-4 max-w-7xl mx-auto">
        <Link to="/" className="text-2xl font-bold">
          <span className="text-primary">Vo</span>cast
        </Link>
        <div className="flex items-center gap-4">
          <Link to="/login">
            <Button variant="ghost" size="sm">Log in</Button>
          </Link>
          <Link to="/signup">
            <Button size="sm">Start Free Trial</Button>
          </Link>
        </div>
      </nav>

      {/* Hero */}
      <section className="px-6 pt-20 pb-32 max-w-4xl mx-auto text-center">
        <h1 className="text-5xl md:text-7xl font-bold tracking-tight leading-tight">
          Your Face. Your Voice.<br />
          <span className="text-primary">Posted Daily.</span>
        </h1>
        <p className="mt-6 text-lg md:text-xl text-muted max-w-2xl mx-auto">
          AI generates and posts daily videos to LinkedIn, Instagram & TikTok — from a single photo.
        </p>
        <Link to="/signup" className="inline-block mt-10">
          <Button size="lg" className="text-lg px-10 py-4">
            Start Free Trial
          </Button>
        </Link>
        <p className="mt-4 text-sm text-muted">No credit card required. Setup in 5 minutes.</p>
      </section>

      {/* Features */}
      <section className="px-6 pb-32 max-w-5xl mx-auto">
        <div className="grid md:grid-cols-3 gap-6">
          {features.map((f) => (
            <Card key={f.title} className="text-center hover:border-primary/30 transition-colors">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-primary/10 text-primary mb-4">
                {f.icon}
              </div>
              <h3 className="text-lg font-semibold mb-2">{f.title}</h3>
              <p className="text-muted text-sm">{f.description}</p>
            </Card>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section className="px-6 pb-32 max-w-5xl mx-auto" id="pricing">
        <h2 className="text-3xl md:text-4xl font-bold text-center mb-4">Simple, Transparent Pricing</h2>
        <p className="text-muted text-center mb-12">Choose the plan that fits your content goals.</p>
        <div className="grid md:grid-cols-3 gap-6">
          {plans.map((plan) => (
            <Card
              key={plan.name}
              className={`relative flex flex-col ${plan.popular ? 'border-primary ring-1 ring-primary' : ''}`}
            >
              {plan.popular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 bg-primary text-white text-xs font-semibold px-3 py-1 rounded-full">
                  Most Popular
                </div>
              )}
              <h3 className="text-xl font-semibold">{plan.name}</h3>
              <div className="mt-4 mb-6">
                <span className="text-4xl font-bold">{plan.price}</span>
                <span className="text-muted">{plan.period}</span>
              </div>
              <ul className="space-y-3 mb-8 flex-1">
                {plan.features.map((f) => (
                  <li key={f} className="flex items-center gap-2 text-sm text-muted">
                    <Check size={16} className="text-primary shrink-0" />
                    {f}
                  </li>
                ))}
              </ul>
              <Link to="/signup">
                <Button variant={plan.popular ? 'primary' : 'outline'} className="w-full">
                  Get Started
                </Button>
              </Link>
            </Card>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border px-6 py-8">
        <div className="max-w-7xl mx-auto flex items-center justify-between text-sm text-muted">
          <span><span className="text-primary font-semibold">Vo</span>cast &copy; 2026</span>
          <div className="flex gap-6">
            <a href="#" className="hover:text-white transition-colors">Privacy</a>
            <a href="#" className="hover:text-white transition-colors">Terms</a>
            <a href="#" className="hover:text-white transition-colors">Contact</a>
          </div>
        </div>
      </footer>
    </div>
  )
}
