// Settings registry - allows commands and features to register their settings

export type SettingType = 'boolean' | 'number' | 'string' | 'enum' | 'array';

export interface SettingDefinition {
  key: string;
  description: string;
  type: SettingType;
  defaultValue: any;
  category?: string;
  options?: string[]; // For enum types
  validate?: (value: any) => boolean;
}

class SettingsRegistry {
  private settings: Map<string, SettingDefinition> = new Map();

  register(setting: SettingDefinition): void {
    if (this.settings.has(setting.key)) {
      console.warn(`Setting ${setting.key} is already registered`);
      return;
    }
    this.settings.set(setting.key, setting);
  }

  registerMultiple(settings: SettingDefinition[]): void {
    settings.forEach(setting => this.register(setting));
  }

  get(key: string): SettingDefinition | undefined {
    return this.settings.get(key);
  }

  getAll(): SettingDefinition[] {
    return Array.from(this.settings.values());
  }

  getByCategory(category: string): SettingDefinition[] {
    return Array.from(this.settings.values()).filter(
      setting => setting.category === category
    );
  }

  has(key: string): boolean {
    return this.settings.has(key);
  }

  // Get default config object from all registered settings
  getDefaultConfig(): any {
    const config: any = {};

    for (const setting of this.settings.values()) {
      const keys = setting.key.split('.');
      let current = config;

      for (let i = 0; i < keys.length - 1; i++) {
        if (!current[keys[i]]) {
          current[keys[i]] = {};
        }
        current = current[keys[i]];
      }

      current[keys[keys.length - 1]] = setting.defaultValue;
    }

    return config;
  }
}

// Singleton instance
export const settingsRegistry = new SettingsRegistry();

// Helper to register settings
export function registerSettings(settings: SettingDefinition[]): void {
  settingsRegistry.registerMultiple(settings);
}
