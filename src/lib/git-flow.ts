// Git Flow operations library

import {
  getCurrentBranch,
  branchExists,
  createBranchFrom,
  switchBranch,
  mergeBranch,
  createTag,
  ensureBranchExists,
  deleteBranch,
  hasUncommittedChanges
} from './git';
import { GitCommandResult } from '../types';
import { updateBranchMetadata } from './metadata';
import { loadConfig, saveConfig } from './config';
import { FlowConfig } from '../types';

// Initialize Git Flow in the repository
export async function initGitFlow(mainBranch: string, developBranch: string): Promise<GitCommandResult> {
  try {
    // Ensure main branch exists
    const mainExists = await branchExists(mainBranch);
    if (!mainExists) {
      return {
        success: false,
        message: `Main branch '${mainBranch}' does not exist`
      };
    }

    // Create develop branch from main if it doesn't exist
    const developExists = await branchExists(developBranch);
    if (!developExists) {
      const result = await createBranchFrom(developBranch, mainBranch);
      if (!result.success) {
        return result;
      }
    }

    // Save flow config to local config
    const config = await loadConfig();
    config.flow = {
      enabled: true,
      mainBranch,
      developBranch,
      featurePrefix: config.flow?.featurePrefix || 'feature/',
      releasePrefix: config.flow?.releasePrefix || 'release/',
      hotfixPrefix: config.flow?.hotfixPrefix || 'hotfix/',
      autoDeleteOnFinish: config.flow?.autoDeleteOnFinish !== undefined ? config.flow.autoDeleteOnFinish : true
    };

    await saveConfig(config);

    return {
      success: true,
      message: `Git Flow initialized with main='${mainBranch}' and develop='${developBranch}'`
    };
  } catch (error: any) {
    return {
      success: false,
      message: error.message || 'Failed to initialize Git Flow'
    };
  }
}

// Get flow config, throw error if not initialized
async function getFlowConfig(): Promise<FlowConfig> {
  const config = await loadConfig();
  if (!config.flow?.enabled) {
    throw new Error('Git Flow not initialized. Run "kunj flow init" first.');
  }
  return config.flow;
}

// Create a feature branch
export async function createFeatureBranch(name: string): Promise<GitCommandResult> {
  try {
    const flowConfig = await getFlowConfig();
    const branchName = flowConfig.featurePrefix ? `${flowConfig.featurePrefix}${name}` : name;

    // Check if branch already exists
    const exists = await branchExists(branchName);
    if (exists) {
      return {
        success: false,
        message: `Branch '${branchName}' already exists`
      };
    }

    // Create branch from develop
    const result = await createBranchFrom(branchName, flowConfig.developBranch);
    if (!result.success) {
      return result;
    }

    // Save metadata
    await updateBranchMetadata(branchName, {
      flowType: 'feature',
      flowBase: flowConfig.developBranch,
      flowStatus: 'active',
      flowCreated: new Date().toISOString()
    });

    return {
      success: true,
      message: `Created and switched to feature branch '${branchName}'`
    };
  } catch (error: any) {
    return {
      success: false,
      message: error.message || 'Failed to create feature branch'
    };
  }
}

// Finish a feature branch
export async function finishFeatureBranch(branchName: string, deleteAfter?: boolean): Promise<GitCommandResult> {
  try {
    const flowConfig = await getFlowConfig();
    const shouldDelete = deleteAfter !== undefined ? deleteAfter : flowConfig.autoDeleteOnFinish;

    // Check if branch exists
    const exists = await branchExists(branchName);
    if (!exists) {
      return {
        success: false,
        message: `Branch '${branchName}' does not exist`
      };
    }

    // Get current branch to see if we need to switch
    const currentBranch = await getCurrentBranch();
    const needsSwitch = currentBranch !== branchName;

    // If we're not on the feature branch, switch to it first
    if (needsSwitch) {
      const switchResult = await switchBranch(branchName);
      if (!switchResult.success) {
        return switchResult;
      }
    }

    // Check for uncommitted changes
    const hasChanges = await hasUncommittedChanges();
    if (hasChanges) {
      return {
        success: false,
        message: 'You have uncommitted changes. Please commit or stash them first.'
      };
    }

    // Switch to develop branch
    const switchToDevelop = await switchBranch(flowConfig.developBranch);
    if (!switchToDevelop.success) {
      return switchToDevelop;
    }

    // Merge feature branch into develop (no fast-forward to preserve history)
    const mergeResult = await mergeBranch(branchName, true);
    if (!mergeResult.success) {
      return mergeResult;
    }

    // Update metadata
    await updateBranchMetadata(branchName, {
      flowStatus: 'finished'
    });

    // Delete feature branch if requested
    if (shouldDelete) {
      const deleteResult = await deleteBranch(branchName, false, false);
      if (!deleteResult.success) {
        return {
          success: true,
          message: `Merged '${branchName}' into '${flowConfig.developBranch}' but failed to delete: ${deleteResult.message}`
        };
      }
      return {
        success: true,
        message: `Finished feature '${branchName}': merged into '${flowConfig.developBranch}' and deleted`
      };
    }

    return {
      success: true,
      message: `Finished feature '${branchName}': merged into '${flowConfig.developBranch}'`
    };
  } catch (error: any) {
    return {
      success: false,
      message: error.message || 'Failed to finish feature branch'
    };
  }
}

// Create a release branch
export async function createReleaseBranch(version: string): Promise<GitCommandResult> {
  try {
    const flowConfig = await getFlowConfig();
    const branchName = flowConfig.releasePrefix ? `${flowConfig.releasePrefix}${version}` : version;

    // Check if branch already exists
    const exists = await branchExists(branchName);
    if (exists) {
      return {
        success: false,
        message: `Branch '${branchName}' already exists`
      };
    }

    // Create branch from develop
    const result = await createBranchFrom(branchName, flowConfig.developBranch);
    if (!result.success) {
      return result;
    }

    // Save metadata
    await updateBranchMetadata(branchName, {
      flowType: 'release',
      flowBase: flowConfig.developBranch,
      flowStatus: 'active',
      flowCreated: new Date().toISOString()
    });

    return {
      success: true,
      message: `Created and switched to release branch '${branchName}'`
    };
  } catch (error: any) {
    return {
      success: false,
      message: error.message || 'Failed to create release branch'
    };
  }
}

// Finish a release branch
export async function finishReleaseBranch(branchName: string, tagName: string, deleteAfter?: boolean): Promise<GitCommandResult> {
  try {
    const flowConfig = await getFlowConfig();
    const shouldDelete = deleteAfter !== undefined ? deleteAfter : flowConfig.autoDeleteOnFinish;

    // Check if branch exists
    const exists = await branchExists(branchName);
    if (!exists) {
      return {
        success: false,
        message: `Branch '${branchName}' does not exist`
      };
    }

    // Get current branch
    const currentBranch = await getCurrentBranch();
    const needsSwitch = currentBranch !== branchName;

    // Switch to release branch if needed
    if (needsSwitch) {
      const switchResult = await switchBranch(branchName);
      if (!switchResult.success) {
        return switchResult;
      }
    }

    // Check for uncommitted changes
    const hasChanges = await hasUncommittedChanges();
    if (hasChanges) {
      return {
        success: false,
        message: 'You have uncommitted changes. Please commit or stash them first.'
      };
    }

    // Switch to main branch
    const switchToMain = await switchBranch(flowConfig.mainBranch);
    if (!switchToMain.success) {
      return switchToMain;
    }

    // Merge release into main
    const mergeToMain = await mergeBranch(branchName, true);
    if (!mergeToMain.success) {
      return mergeToMain;
    }

    // Create tag on main
    const tagResult = await createTag(tagName, `Release ${tagName}`);
    if (!tagResult.success) {
      return {
        success: false,
        message: `Merged to ${flowConfig.mainBranch} but failed to create tag: ${tagResult.message}`
      };
    }

    // Switch to develop branch
    const switchToDevelop = await switchBranch(flowConfig.developBranch);
    if (!switchToDevelop.success) {
      return {
        success: false,
        message: `Merged to ${flowConfig.mainBranch} and tagged, but failed to switch to ${flowConfig.developBranch}: ${switchToDevelop.message}`
      };
    }

    // Merge release back into develop
    const mergeToDevelop = await mergeBranch(branchName, true);
    if (!mergeToDevelop.success) {
      return {
        success: false,
        message: `Merged to ${flowConfig.mainBranch} and tagged, but failed to merge back to ${flowConfig.developBranch}: ${mergeToDevelop.message}`
      };
    }

    // Update metadata
    await updateBranchMetadata(branchName, {
      flowStatus: 'finished'
    });

    // Delete release branch if requested
    if (shouldDelete) {
      const deleteResult = await deleteBranch(branchName, false, false);
      if (!deleteResult.success) {
        return {
          success: true,
          message: `Finished release '${branchName}' but failed to delete: ${deleteResult.message}`
        };
      }
      return {
        success: true,
        message: `Finished release '${branchName}': merged to '${flowConfig.mainBranch}', tagged '${tagName}', merged back to '${flowConfig.developBranch}', and deleted`
      };
    }

    return {
      success: true,
      message: `Finished release '${branchName}': merged to '${flowConfig.mainBranch}', tagged '${tagName}', and merged back to '${flowConfig.developBranch}'`
    };
  } catch (error: any) {
    return {
      success: false,
      message: error.message || 'Failed to finish release branch'
    };
  }
}

// Create a hotfix branch
export async function createHotfixBranch(version: string): Promise<GitCommandResult> {
  try {
    const flowConfig = await getFlowConfig();
    const branchName = flowConfig.hotfixPrefix ? `${flowConfig.hotfixPrefix}${version}` : version;

    // Check if branch already exists
    const exists = await branchExists(branchName);
    if (exists) {
      return {
        success: false,
        message: `Branch '${branchName}' already exists`
      };
    }

    // Create branch from main
    const result = await createBranchFrom(branchName, flowConfig.mainBranch);
    if (!result.success) {
      return result;
    }

    // Save metadata
    await updateBranchMetadata(branchName, {
      flowType: 'hotfix',
      flowBase: flowConfig.mainBranch,
      flowStatus: 'active',
      flowCreated: new Date().toISOString()
    });

    return {
      success: true,
      message: `Created and switched to hotfix branch '${branchName}'`
    };
  } catch (error: any) {
    return {
      success: false,
      message: error.message || 'Failed to create hotfix branch'
    };
  }
}

// Finish a hotfix branch
export async function finishHotfixBranch(branchName: string, tagName: string, deleteAfter?: boolean): Promise<GitCommandResult> {
  try {
    const flowConfig = await getFlowConfig();
    const shouldDelete = deleteAfter !== undefined ? deleteAfter : flowConfig.autoDeleteOnFinish;

    // Check if branch exists
    const exists = await branchExists(branchName);
    if (!exists) {
      return {
        success: false,
        message: `Branch '${branchName}' does not exist`
      };
    }

    // Get current branch
    const currentBranch = await getCurrentBranch();
    const needsSwitch = currentBranch !== branchName;

    // Switch to hotfix branch if needed
    if (needsSwitch) {
      const switchResult = await switchBranch(branchName);
      if (!switchResult.success) {
        return switchResult;
      }
    }

    // Check for uncommitted changes
    const hasChanges = await hasUncommittedChanges();
    if (hasChanges) {
      return {
        success: false,
        message: 'You have uncommitted changes. Please commit or stash them first.'
      };
    }

    // Switch to main branch
    const switchToMain = await switchBranch(flowConfig.mainBranch);
    if (!switchToMain.success) {
      return switchToMain;
    }

    // Merge hotfix into main
    const mergeToMain = await mergeBranch(branchName, true);
    if (!mergeToMain.success) {
      return mergeToMain;
    }

    // Create tag on main
    const tagResult = await createTag(tagName, `Hotfix ${tagName}`);
    if (!tagResult.success) {
      return {
        success: false,
        message: `Merged to ${flowConfig.mainBranch} but failed to create tag: ${tagResult.message}`
      };
    }

    // Switch to develop branch
    const switchToDevelop = await switchBranch(flowConfig.developBranch);
    if (!switchToDevelop.success) {
      return {
        success: false,
        message: `Merged to ${flowConfig.mainBranch} and tagged, but failed to switch to ${flowConfig.developBranch}: ${switchToDevelop.message}`
      };
    }

    // Merge hotfix back into develop
    const mergeToDevelop = await mergeBranch(branchName, true);
    if (!mergeToDevelop.success) {
      return {
        success: false,
        message: `Merged to ${flowConfig.mainBranch} and tagged, but failed to merge back to ${flowConfig.developBranch}: ${mergeToDevelop.message}`
      };
    }

    // Update metadata
    await updateBranchMetadata(branchName, {
      flowStatus: 'finished'
    });

    // Delete hotfix branch if requested
    if (shouldDelete) {
      const deleteResult = await deleteBranch(branchName, false, false);
      if (!deleteResult.success) {
        return {
          success: true,
          message: `Finished hotfix '${branchName}' but failed to delete: ${deleteResult.message}`
        };
      }
      return {
        success: true,
        message: `Finished hotfix '${branchName}': merged to '${flowConfig.mainBranch}', tagged '${tagName}', merged back to '${flowConfig.developBranch}', and deleted`
      };
    }

    return {
      success: true,
      message: `Finished hotfix '${branchName}': merged to '${flowConfig.mainBranch}', tagged '${tagName}', and merged back to '${flowConfig.developBranch}'`
    };
  } catch (error: any) {
    return {
      success: false,
      message: error.message || 'Failed to finish hotfix branch'
    };
  }
}
