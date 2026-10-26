import DefaultTheme from 'vitepress/theme'
import './custom.css'
import DeploymentChecklist from './components/DeploymentChecklist.vue'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('DeploymentChecklist', DeploymentChecklist)
  }
}
