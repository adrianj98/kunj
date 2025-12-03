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
  hasUncommittedChanges,
  pullBranch,
  pushBranch
} from './git';
import { GitCommandResult } from '../types';
import { updateBranchMetadata } from './metadata';
import { loadConfig, saveConfig } from './config';
import { FlowConfig } from '../types';
import { getPRProvider } from './pr-providers';

// Initialize Git Flow in the repository
export async function initGitFlow(
  mainBranch: string,
  developBranch: string,
  mode: 'local' | 'pr' = 'local',
  prProvider: 'github' | 'gitlab' = 'github',
  mergeBackToDevelop: boolean = true
): Promise<GitCommandResult> {
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
      autoDeleteOnFinish: config.flow?.autoDeleteOnFinish !== undefined ? config.flow.autoDeleteOnFinish : true,
      mode,
      prProvider,
      mergeBackToDevelop
    };

    await saveConfig(config);

    const modeMsg = mode === 'pr' ? ` (PR mode with ${prProvider})` : ' (local mode)';
    return {
      success: true,
      message: `Git Flow initialized with main='${mainBranch}' and develop='${developBranch}'${modeMsg}`
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

    if (flowConfig.mode === 'pr') {
      // PR mode: checkout develop, pull, create branch, push, create PR

      // Switch to develop
      const switchResult = await switchBranch(flowConfig.developBranch);
      if (!switchResult.success) {
        return switchResult;
      }

      // Pull latest from develop
      const pullResult = await pullBranch(flowConfig.developBranch);
      if (!pullResult.success) {
        return {
          success: false,
          message: `Failed to pull ${flowConfig.developBranch}: ${pullResult.message}`
        };
      }

      // Create branch from develop
      const createResult = await createBranchFrom(branchName, flowConfig.developBranch);
      if (!createResult.success) {
        return createResult;
      }

      // Push branch to remote
      const pushResult = await pushBranch(branchName, true);
      if (!pushResult.success) {
        return {
          success: false,
          message: `Created branch but failed to push: ${pushResult.message}`
        };
      }

      // Create PR
      const provider = getPRProvider(flowConfig.prProvider);
      const prResult = await provider.createPR(
        branchName,
        flowConfig.developBranch,
        `Feature: ${name}`,
        `Feature branch for ${name}`
      );

      // Save metadata
      await updateBranchMetadata(branchName, {
        flowType: 'feature',
        flowBase: flowConfig.developBranch,
        flowStatus: 'active',
        flowCreated: new Date().toISOString(),
        prUrl: prResult.success ? prResult.prUrl : undefined
      });

      if (prResult.success) {
        return {
          success: true,
          message: `Created feature branch '${branchName}', pushed to remote, and created PR\n  ${prResult.prUrl || ''}`
        };
      } else {
        return {
          success: true,
          message: `Created and pushed feature branch '${branchName}', but PR creation failed: ${prResult.message}`
        };
      }
    } else {
      // Local mode: traditional git flow

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
    }
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

    if (flowConfig.mode === 'pr') {
      // PR mode: push any remaining commits and merge the PR

      // Push any remaining commits
      const pushResult = await pushBranch(branchName);
      if (!pushResult.success) {
        return {
          success: false,
          message: `Failed to push branch: ${pushResult.message}`
        };
      }

      // Merge the PR
      const provider = getPRProvider(flowConfig.prProvider);
      const mergeResult = await provider.mergePR(branchName, flowConfig.developBranch);

      if (!mergeResult.success) {
        return {
          success: false,
          message: `Failed to merge PR: ${mergeResult.message}`
        };
      }

      // Switch to develop and pull
      const switchToDevelop = await switchBranch(flowConfig.developBranch);
      if (!switchToDevelop.success) {
        return {
          success: false,
          message: `PR merged but failed to switch to ${flowConfig.developBranch}: ${switchToDevelop.message}`
        };
      }

      const pullResult = await pullBranch(flowConfig.developBranch);
      if (!pullResult.success) {
        return {
          success: false,
          message: `PR merged but failed to pull ${flowConfig.developBranch}: ${pullResult.message}`
        };
      }

      // Update metadata
      await updateBranchMetadata(branchName, {
        flowStatus: 'finished'
      });

      // Delete local feature branch if requested
      if (shouldDelete) {
        const deleteResult = await deleteBranch(branchName, false, false);
        if (!deleteResult.success) {
          return {
            success: true,
            message: `Finished feature '${branchName}': ${mergeResult.message}, but failed to delete local branch: ${deleteResult.message}`
          };
        }
        return {
          success: true,
          message: `Finished feature '${branchName}': ${mergeResult.message} and deleted local branch`
        };
      }

      return {
        success: true,
        message: `Finished feature '${branchName}': ${mergeResult.message}`
      };
    } else {
      // Local mode: traditional git flow

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
    }
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

    if (flowConfig.mode === 'pr') {
      // PR mode: checkout develop, pull, create branch, push, create PR to main

      // Switch to develop
      const switchResult = await switchBranch(flowConfig.developBranch);
      if (!switchResult.success) {
        return switchResult;
      }

      // Pull latest from develop
      const pullResult = await pullBranch(flowConfig.developBranch);
      if (!pullResult.success) {
        return {
          success: false,
          message: `Failed to pull ${flowConfig.developBranch}: ${pullResult.message}`
        };
      }

      // Create branch from develop
      const createResult = await createBranchFrom(branchName, flowConfig.developBranch);
      if (!createResult.success) {
        return createResult;
      }

      // Push branch to remote
      const pushResult = await pushBranch(branchName, true);
      if (!pushResult.success) {
        return {
          success: false,
          message: `Created branch but failed to push: ${pushResult.message}`
        };
      }

      // Create PR to main
      const provider = getPRProvider(flowConfig.prProvider);
      const prResult = await provider.createPR(
        branchName,
        flowConfig.mainBranch,
        `Release: ${version}`,
        `Release ${version} from develop`
      );

      // Save metadata
      await updateBranchMetadata(branchName, {
        flowType: 'release',
        flowBase: flowConfig.developBranch,
        flowStatus: 'active',
        flowCreated: new Date().toISOString(),
        prUrl: prResult.success ? prResult.prUrl : undefined
      });

      if (prResult.success) {
        return {
          success: true,
          message: `Created release branch '${branchName}', pushed to remote, and created PR to ${flowConfig.mainBranch}\n  ${prResult.prUrl || ''}`
        };
      } else {
        return {
          success: true,
          message: `Created and pushed release branch '${branchName}', but PR creation failed: ${prResult.message}`
        };
      }
    } else {
      // Local mode: traditional git flow

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
    }
  } catch (error: any) {
    return {
      success: false,
      message: error.message || 'Failed to create release branch'
    };
  }
}

// Finish a release branch
export async function finishReleaseBranch(branchName: string, tagName?: string, deleteAfter?: boolean): Promise<GitCommandResult> {
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

    if (flowConfig.mode === 'pr') {
      // PR mode: merge PR to main, tag, optionally merge back to develop

      // Push any remaining commits
      const pushResult = await pushBranch(branchName);
      if (!pushResult.success) {
        return {
          success: false,
          message: `Failed to push branch: ${pushResult.message}`
        };
      }

      // Merge the PR to main
      const provider = getPRProvider(flowConfig.prProvider);
      const mergeToMainResult = await provider.mergePR(branchName, flowConfig.mainBranch);

      if (!mergeToMainResult.success) {
        return {
          success: false,
          message: `Failed to merge PR to ${flowConfig.mainBranch}: ${mergeToMainResult.message}`
        };
      }

      // Switch to main and pull
      const switchToMain = await switchBranch(flowConfig.mainBranch);
      if (!switchToMain.success) {
        return {
          success: false,
          message: `PR merged but failed to switch to ${flowConfig.mainBranch}: ${switchToMain.message}`
        };
      }

      const pullMain = await pullBranch(flowConfig.mainBranch);
      if (!pullMain.success) {
        return {
          success: false,
          message: `PR merged but failed to pull ${flowConfig.mainBranch}: ${pullMain.message}`
        };
      }

      // Create tag on main if tagName is provided
      let tagCreated = false;
      if (tagName && tagName.trim()) {
        const tagResult = await createTag(tagName, `Release ${tagName}`);
        if (!tagResult.success) {
          return {
            success: false,
            message: `Merged to ${flowConfig.mainBranch} but failed to create tag: ${tagResult.message}`
          };
        }

        // Push tag to remote
        const pushTagResult = await pushBranch(tagName);
        if (!pushTagResult.success) {
          return {
            success: false,
            message: `Created tag ${tagName} but failed to push: ${pushTagResult.message}`
          };
        }

        tagCreated = true;
      }

      // Merge back to develop if configured
      let mergeBackMsg = '';
      if (flowConfig.mergeBackToDevelop) {
        // Create PR from main to develop for the merge-back
        const mergeBackPRResult = await provider.createPR(
          flowConfig.mainBranch,
          flowConfig.developBranch,
          `Merge release ${tagName || branchName} back to develop`,
          `Merge release changes back to develop branch`
        );

        if (mergeBackPRResult.success) {
          // Auto-merge the merge-back PR
          const mergeBackResult = await provider.mergePR(flowConfig.mainBranch, flowConfig.developBranch);
          if (mergeBackResult.success) {
            mergeBackMsg = `, merged back to ${flowConfig.developBranch}`;
          } else {
            mergeBackMsg = `, created merge-back PR but auto-merge failed: ${mergeBackResult.message}`;
          }
        } else {
          mergeBackMsg = `, failed to create merge-back PR: ${mergeBackPRResult.message}`;
        }
      }

      // Switch to develop and pull
      const switchToDevelop = await switchBranch(flowConfig.developBranch);
      if (!switchToDevelop.success) {
        return {
          success: false,
          message: `Release finished but failed to switch to ${flowConfig.developBranch}: ${switchToDevelop.message}`
        };
      }

      const pullDevelop = await pullBranch(flowConfig.developBranch);
      if (!pullDevelop.success) {
        return {
          success: false,
          message: `Release finished but failed to pull ${flowConfig.developBranch}: ${pullDevelop.message}`
        };
      }

      // Update metadata
      await updateBranchMetadata(branchName, {
        flowStatus: 'finished'
      });

      // Build success message
      let successMsg = `Finished release '${branchName}': merged to '${flowConfig.mainBranch}'`;
      if (tagCreated) {
        successMsg += `, tagged '${tagName}'`;
      }
      successMsg += mergeBackMsg;

      // Delete local release branch if requested
      if (shouldDelete) {
        const deleteResult = await deleteBranch(branchName, false, false);
        if (!deleteResult.success) {
          return {
            success: true,
            message: `${successMsg}, but failed to delete local branch: ${deleteResult.message}`
          };
        }
        successMsg += ', and deleted local branch';
      }

      return {
        success: true,
        message: successMsg
      };
    } else {
      // Local mode: traditional git flow

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

      // Create tag on main if tagName is provided
      let tagCreated = false;
      if (tagName && tagName.trim()) {
        const tagResult = await createTag(tagName, `Release ${tagName}`);
        if (!tagResult.success) {
          return {
            success: false,
            message: `Merged to ${flowConfig.mainBranch} but failed to create tag: ${tagResult.message}`
          };
        }
        tagCreated = true;
      }

      // Merge back to develop if configured
      let mergeBackMsg = '';
      if (flowConfig.mergeBackToDevelop) {
        // Switch to develop branch
        const switchToDevelop = await switchBranch(flowConfig.developBranch);
        if (!switchToDevelop.success) {
          const tagMsg = tagCreated ? ' and tagged' : '';
          return {
            success: false,
            message: `Merged to ${flowConfig.mainBranch}${tagMsg}, but failed to switch to ${flowConfig.developBranch}: ${switchToDevelop.message}`
          };
        }

        // Merge release back into develop
        const mergeToDevelop = await mergeBranch(branchName, true);
        if (!mergeToDevelop.success) {
          const tagMsg = tagCreated ? ' and tagged' : '';
          return {
            success: false,
            message: `Merged to ${flowConfig.mainBranch}${tagMsg}, but failed to merge back to ${flowConfig.developBranch}: ${mergeToDevelop.message}`
          };
        }
        mergeBackMsg = `, merged back to '${flowConfig.developBranch}'`;
      } else {
        // Just switch to develop without merging
        const switchToDevelop = await switchBranch(flowConfig.developBranch);
        if (!switchToDevelop.success) {
          const tagMsg = tagCreated ? ' and tagged' : '';
          return {
            success: false,
            message: `Merged to ${flowConfig.mainBranch}${tagMsg}, but failed to switch to ${flowConfig.developBranch}: ${switchToDevelop.message}`
          };
        }
      }

      // Update metadata
      await updateBranchMetadata(branchName, {
        flowStatus: 'finished'
      });

      // Build success message
      let successMsg = `Finished release '${branchName}': merged to '${flowConfig.mainBranch}'`;
      if (tagCreated) {
        successMsg += `, tagged '${tagName}'`;
      }
      successMsg += mergeBackMsg;

      // Delete release branch if requested
      if (shouldDelete) {
        const deleteResult = await deleteBranch(branchName, false, false);
        if (!deleteResult.success) {
          return {
            success: true,
            message: `${successMsg} but failed to delete: ${deleteResult.message}`
          };
        }
        successMsg += ', and deleted';
      }

      return {
        success: true,
        message: successMsg
      };
    }
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

    if (flowConfig.mode === 'pr') {
      // PR mode: checkout main, pull, create branch, push, create PR to main

      // Switch to main
      const switchResult = await switchBranch(flowConfig.mainBranch);
      if (!switchResult.success) {
        return switchResult;
      }

      // Pull latest from main
      const pullResult = await pullBranch(flowConfig.mainBranch);
      if (!pullResult.success) {
        return {
          success: false,
          message: `Failed to pull ${flowConfig.mainBranch}: ${pullResult.message}`
        };
      }

      // Create branch from main
      const createResult = await createBranchFrom(branchName, flowConfig.mainBranch);
      if (!createResult.success) {
        return createResult;
      }

      // Push branch to remote
      const pushResult = await pushBranch(branchName, true);
      if (!pushResult.success) {
        return {
          success: false,
          message: `Created branch but failed to push: ${pushResult.message}`
        };
      }

      // Create PR to main
      const provider = getPRProvider(flowConfig.prProvider);
      const prResult = await provider.createPR(
        branchName,
        flowConfig.mainBranch,
        `Hotfix: ${version}`,
        `Hotfix ${version} from main`
      );

      // Save metadata
      await updateBranchMetadata(branchName, {
        flowType: 'hotfix',
        flowBase: flowConfig.mainBranch,
        flowStatus: 'active',
        flowCreated: new Date().toISOString(),
        prUrl: prResult.success ? prResult.prUrl : undefined
      });

      if (prResult.success) {
        return {
          success: true,
          message: `Created hotfix branch '${branchName}', pushed to remote, and created PR to ${flowConfig.mainBranch}\n  ${prResult.prUrl || ''}`
        };
      } else {
        return {
          success: true,
          message: `Created and pushed hotfix branch '${branchName}', but PR creation failed: ${prResult.message}`
        };
      }
    } else {
      // Local mode: traditional git flow

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
    }
  } catch (error: any) {
    return {
      success: false,
      message: error.message || 'Failed to create hotfix branch'
    };
  }
}

// Finish a hotfix branch
export async function finishHotfixBranch(branchName: string, tagName?: string, deleteAfter?: boolean): Promise<GitCommandResult> {
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

    if (flowConfig.mode === 'pr') {
      // PR mode: merge PR to main, tag, optionally merge back to develop

      // Push any remaining commits
      const pushResult = await pushBranch(branchName);
      if (!pushResult.success) {
        return {
          success: false,
          message: `Failed to push branch: ${pushResult.message}`
        };
      }

      // Merge the PR to main
      const provider = getPRProvider(flowConfig.prProvider);
      const mergeToMainResult = await provider.mergePR(branchName, flowConfig.mainBranch);

      if (!mergeToMainResult.success) {
        return {
          success: false,
          message: `Failed to merge PR to ${flowConfig.mainBranch}: ${mergeToMainResult.message}`
        };
      }

      // Switch to main and pull
      const switchToMain = await switchBranch(flowConfig.mainBranch);
      if (!switchToMain.success) {
        return {
          success: false,
          message: `PR merged but failed to switch to ${flowConfig.mainBranch}: ${switchToMain.message}`
        };
      }

      const pullMain = await pullBranch(flowConfig.mainBranch);
      if (!pullMain.success) {
        return {
          success: false,
          message: `PR merged but failed to pull ${flowConfig.mainBranch}: ${pullMain.message}`
        };
      }

      // Create tag on main if tagName is provided
      let tagCreated = false;
      if (tagName && tagName.trim()) {
        const tagResult = await createTag(tagName, `Hotfix ${tagName}`);
        if (!tagResult.success) {
          return {
            success: false,
            message: `Merged to ${flowConfig.mainBranch} but failed to create tag: ${tagResult.message}`
          };
        }

        // Push tag to remote
        const pushTagResult = await pushBranch(tagName);
        if (!pushTagResult.success) {
          return {
            success: false,
            message: `Created tag ${tagName} but failed to push: ${pushTagResult.message}`
          };
        }

        tagCreated = true;
      }

      // Merge back to develop if configured
      let mergeBackMsg = '';
      if (flowConfig.mergeBackToDevelop) {
        // Create PR from main to develop for the merge-back
        const mergeBackPRResult = await provider.createPR(
          flowConfig.mainBranch,
          flowConfig.developBranch,
          `Merge hotfix ${tagName || branchName} back to develop`,
          `Merge hotfix changes back to develop branch`
        );

        if (mergeBackPRResult.success) {
          // Auto-merge the merge-back PR
          const mergeBackResult = await provider.mergePR(flowConfig.mainBranch, flowConfig.developBranch);
          if (mergeBackResult.success) {
            mergeBackMsg = `, merged back to ${flowConfig.developBranch}`;
          } else {
            mergeBackMsg = `, created merge-back PR but auto-merge failed: ${mergeBackResult.message}`;
          }
        } else {
          mergeBackMsg = `, failed to create merge-back PR: ${mergeBackPRResult.message}`;
        }
      }

      // Switch to develop and pull
      const switchToDevelop = await switchBranch(flowConfig.developBranch);
      if (!switchToDevelop.success) {
        return {
          success: false,
          message: `Hotfix finished but failed to switch to ${flowConfig.developBranch}: ${switchToDevelop.message}`
        };
      }

      const pullDevelop = await pullBranch(flowConfig.developBranch);
      if (!pullDevelop.success) {
        return {
          success: false,
          message: `Hotfix finished but failed to pull ${flowConfig.developBranch}: ${pullDevelop.message}`
        };
      }

      // Update metadata
      await updateBranchMetadata(branchName, {
        flowStatus: 'finished'
      });

      // Build success message
      let successMsg = `Finished hotfix '${branchName}': merged to '${flowConfig.mainBranch}'`;
      if (tagCreated) {
        successMsg += `, tagged '${tagName}'`;
      }
      successMsg += mergeBackMsg;

      // Delete local hotfix branch if requested
      if (shouldDelete) {
        const deleteResult = await deleteBranch(branchName, false, false);
        if (!deleteResult.success) {
          return {
            success: true,
            message: `${successMsg}, but failed to delete local branch: ${deleteResult.message}`
          };
        }
        successMsg += ', and deleted local branch';
      }

      return {
        success: true,
        message: successMsg
      };
    } else {
      // Local mode: traditional git flow

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

      // Create tag on main if tagName is provided
      let tagCreated = false;
      if (tagName && tagName.trim()) {
        const tagResult = await createTag(tagName, `Hotfix ${tagName}`);
        if (!tagResult.success) {
          return {
            success: false,
            message: `Merged to ${flowConfig.mainBranch} but failed to create tag: ${tagResult.message}`
          };
        }
        tagCreated = true;
      }

      // Merge back to develop if configured
      let mergeBackMsg = '';
      if (flowConfig.mergeBackToDevelop) {
        // Switch to develop branch
        const switchToDevelop = await switchBranch(flowConfig.developBranch);
        if (!switchToDevelop.success) {
          const tagMsg = tagCreated ? ' and tagged' : '';
          return {
            success: false,
            message: `Merged to ${flowConfig.mainBranch}${tagMsg}, but failed to switch to ${flowConfig.developBranch}: ${switchToDevelop.message}`
          };
        }

        // Merge hotfix back into develop
        const mergeToDevelop = await mergeBranch(branchName, true);
        if (!mergeToDevelop.success) {
          const tagMsg = tagCreated ? ' and tagged' : '';
          return {
            success: false,
            message: `Merged to ${flowConfig.mainBranch}${tagMsg}, but failed to merge back to ${flowConfig.developBranch}: ${mergeToDevelop.message}`
          };
        }
        mergeBackMsg = `, merged back to '${flowConfig.developBranch}'`;
      } else {
        // Just switch to develop without merging
        const switchToDevelop = await switchBranch(flowConfig.developBranch);
        if (!switchToDevelop.success) {
          const tagMsg = tagCreated ? ' and tagged' : '';
          return {
            success: false,
            message: `Merged to ${flowConfig.mainBranch}${tagMsg}, but failed to switch to ${flowConfig.developBranch}: ${switchToDevelop.message}`
          };
        }
      }

      // Update metadata
      await updateBranchMetadata(branchName, {
        flowStatus: 'finished'
      });

      // Build success message
      let successMsg = `Finished hotfix '${branchName}': merged to '${flowConfig.mainBranch}'`;
      if (tagCreated) {
        successMsg += `, tagged '${tagName}'`;
      }
      successMsg += mergeBackMsg;

      // Delete hotfix branch if requested
      if (shouldDelete) {
        const deleteResult = await deleteBranch(branchName, false, false);
        if (!deleteResult.success) {
          return {
            success: true,
            message: `${successMsg} but failed to delete: ${deleteResult.message}`
          };
        }
        successMsg += ', and deleted';
      }

      return {
        success: true,
        message: successMsg
      };
    }
  } catch (error: any) {
    return {
      success: false,
      message: error.message || 'Failed to finish hotfix branch'
    };
  }
}
